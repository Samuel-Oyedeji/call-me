#!/usr/bin/env bun

/**
 * CallMe MCP Server
 *
 * A stdio-based MCP server that lets Claude call you on the phone.
 * Automatically starts ngrok to expose webhooks for phone providers.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CallManager, loadServerConfig } from './phone-call.js';
import { startNgrok, stopNgrok } from './ngrok.js';
import { findOtherCallMeServers, closeOtherCallMeServers } from './sessions.js';
import { ensureKokoroRunning } from './providers/tts-kokoro.js';
import { loadProviderConfig } from './providers/index.js';

async function main() {
  // Get port for HTTP server (default 0 = ephemeral, OS picks free port)
  const port = parseInt(process.env.CALLME_PORT || '0', 10);

  // Auto-setup Kokoro Docker container if needed (before config validation)
  const providerConfig = loadProviderConfig();
  if (providerConfig.ttsProvider === 'kokoro' && !providerConfig.kokoroUrl) {
    try {
      const kokoroBaseUrl = await ensureKokoroRunning();
      process.env.CALLME_KOKORO_URL = `${kokoroBaseUrl}/v1`;
    } catch (error) {
      console.error('Kokoro setup failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }

  // Load server config (validates env vars, no network needed)
  let serverConfig;
  try {
    serverConfig = loadServerConfig('');
  } catch (error) {
    console.error('Configuration error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // Create call manager and bind HTTP server FIRST (before ngrok)
  const callManager = new CallManager(serverConfig);
  let actualPort: number;
  try {
    actualPort = await callManager.startServer();
  } catch (error) {
    console.error('Failed to start HTTP server:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // Start ngrok tunnel pointing at the actual bound port.
  //
  // A tunnel failure must NOT kill the process. Exiting here means the MCP server
  // never registers, so the calling agent sees no call tools at all and reports the
  // capability as simply missing — which tells the user nothing about the real cause.
  // Stay up instead, and let the call tools explain the problem and offer a fix.
  let publicUrl: string | null = null;
  let tunnelError: string | null = null;

  const startTunnel = async (): Promise<boolean> => {
    console.error('Starting ngrok tunnel...');
    try {
      const url = await startNgrok(actualPort, (newUrl) => {
        console.error(`[ngrok] Updating public URL to: ${newUrl}`);
        callManager.setPublicUrl(newUrl);
      });
      publicUrl = url;
      callManager.setPublicUrl(url);
      tunnelError = null;
      console.error(`ngrok tunnel: ${url}`);
      return true;
    } catch (error) {
      tunnelError = error instanceof Error ? error.message : String(error);
      publicUrl = null;
      console.error('Failed to start ngrok:', tunnelError);
      console.error('Continuing WITHOUT a tunnel. Call tools will report why and how to fix it.');
      return false;
    }
  };

  await startTunnel();

  /** Loud, actionable explanation returned in place of a call. */
  const noTunnelMessage = (): string => {
    const others = findOtherCallMeServers();
    const atLimit = /ERR_NGROK_108|simultaneous/i.test(tunnelError || '');

    const lines = [
      'CANNOT PLACE CALL - no public tunnel is available.',
      '',
      `ngrok reported: ${tunnelError || 'no tunnel established'}`,
      '',
    ];

    // Only offer the "close other sessions" route when contention is actually the
    // cause. Offering it for an invalid authtoken would send the user to shut down
    // unrelated work that was never the problem.
    if (!atLimit) {
      lines.push(
        'This is NOT the ngrok session limit - closing other Claude sessions will not help.',
        'Report the ngrok error above to the user and fix that instead. A bad or missing',
        'CALLME_NGROK_AUTHTOKEN is the usual cause: correct it in the env block of',
        '~/.claude/settings.json, then fully restart Claude Code so the value is picked up.',
        '',
        'Do not attempt another call until the tunnel error is resolved.',
      );
      return lines.join('\n');
    }

    lines.push(
      "Cause: ngrok's free plan allows 3 simultaneous tunnels, and every open Claude Code",
      'session starts its own CallMe server with its own tunnel. Other sessions have taken',
      'every slot, so this session has no webhook URL for the phone provider to call back to.',
      '',
      others.length
        ? `Found ${others.length} other CallMe server(s) running: ${others.map((p) => `pid ${p.pid}`).join(', ')}`
        : 'No other CallMe servers found on this machine, so the slots are held by ngrok agents\n' +
          'outside Claude Code. Check https://dashboard.ngrok.com/agents.',
      '',
      'ASK THE USER THIS AS AN OPEN QUESTION AND WAIT FOR THEIR ANSWER. Do not decide for them:',
      '',
      '  "You have multiple Claude sessions open and they have used up all your ngrok tunnels,',
      '   so I have no webhook and cannot place the call. You can close some of those sessions',
      '   yourself, or I can close them for you from here. Which would you prefer?"',
      '',
      'If they want to handle it themselves, any of these works:',
      '  - Quit one of the other Claude Code sessions entirely; or',
      '  - Keep that session open but turn CallMe off in it: run /plugin in that session,',
      '    select CallMe, and disable it. That frees its tunnel without losing any work; or',
      '  - Upgrade the ngrok plan to lift the 3-tunnel limit.',
      '  Then restart THIS session so it picks up the freed slot.',
      '',
      'If they want you to do it, call the close_other_callme_sessions tool. It stops only the',
      'other CallMe servers - it does not close those Claude sessions or touch their work - and',
      'then retries the tunnel here.',
      '',
      'Do not attempt another call until one of those has happened.',
    );

    return lines.join('\n');
  };

  // Create stdio MCP server
  const mcpServer = new Server(
    { name: 'callme', version: '3.0.0' },
    { capabilities: { tools: {} } }
  );

  // List available tools
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'initiate_call',
          description: 'Start a phone call with the user. Use when you need voice input, want to report completed work, or need real-time discussion.',
          inputSchema: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
                description: 'What you want to say to the user. Be natural and conversational.',
              },
            },
            required: ['message'],
          },
        },
        {
          name: 'continue_call',
          description: 'Continue an active call with a follow-up message.',
          inputSchema: {
            type: 'object',
            properties: {
              call_id: { type: 'string', description: 'The call ID from initiate_call' },
              message: { type: 'string', description: 'Your follow-up message' },
            },
            required: ['call_id', 'message'],
          },
        },
        {
          name: 'speak_to_user',
          description: 'Speak a message on an active call without waiting for a response. Use this to acknowledge requests or provide status updates before starting time-consuming operations.',
          inputSchema: {
            type: 'object',
            properties: {
              call_id: { type: 'string', description: 'The call ID from initiate_call' },
              message: { type: 'string', description: 'What to say to the user' },
            },
            required: ['call_id', 'message'],
          },
        },
        {
          name: 'end_call',
          description: 'End an active call with a closing message.',
          inputSchema: {
            type: 'object',
            properties: {
              call_id: { type: 'string', description: 'The call ID from initiate_call' },
              message: { type: 'string', description: 'Your closing message (say goodbye!)' },
            },
            required: ['call_id', 'message'],
          },
        },
        {
          name: 'close_other_callme_sessions',
          description:
            'Free an ngrok tunnel slot by stopping CallMe servers belonging to OTHER Claude sessions, then retry this session\'s tunnel. ' +
            'Only call this after the user has explicitly agreed to it. It stops the other CallMe servers only - it does not close ' +
            'those Claude Code sessions or affect their work, though calling will stop working in them until they restart.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    };
  });

  // Handle tool calls
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      if (request.params.name === 'close_other_callme_sessions') {
        const { stopped, failed } = closeOtherCallMeServers();

        if (stopped.length === 0 && failed.length === 0) {
          return {
            content: [{
              type: 'text',
              text: 'No other CallMe servers were running, so no tunnel slot was freed.\n\n' +
                    `The tunnel is still unavailable: ${tunnelError || 'unknown reason'}\n\n` +
                    'The limit is likely held by ngrok agents outside Claude Code, or the authtoken is invalid. ' +
                    'Tell the user to check https://dashboard.ngrok.com/agents for active sessions.',
            }],
            isError: true,
          };
        }

        // Give the stopped servers a moment to release their tunnels.
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const recovered = await startTunnel();

        const report = [
          `Stopped ${stopped.length} other CallMe server(s): ${stopped.map((p) => `pid ${p}`).join(', ')}`,
          ...(failed.length ? [`Could not stop: ${failed.map((f) => `pid ${f.pid} (${f.reason})`).join(', ')}`] : []),
          '',
          recovered
            ? 'Tunnel established. You can place the call now.'
            : `Still no tunnel: ${tunnelError}\nTell the user, and do not retry blindly.`,
          '',
          'Calling is now disabled in those other sessions until each one is restarted.',
        ].join('\n');

        return { content: [{ type: 'text', text: report }], isError: !recovered };
      }

      // Every call tool needs a public URL for the phone provider to reach back to.
      const needsTunnel = ['initiate_call', 'continue_call', 'speak_to_user', 'end_call'];
      if (needsTunnel.includes(request.params.name) && !publicUrl) {
        return { content: [{ type: 'text', text: noTunnelMessage() }], isError: true };
      }

      if (request.params.name === 'initiate_call') {
        const { message } = request.params.arguments as { message: string };
        const result = await callManager.initiateCall(message);

        return {
          content: [{
            type: 'text',
            text: `Call initiated successfully.\n\nCall ID: ${result.callId}\n\nUser's response:\n${result.response}\n\nUse continue_call to ask follow-ups or end_call to hang up.`,
          }],
        };
      }

      if (request.params.name === 'continue_call') {
        const { call_id, message } = request.params.arguments as { call_id: string; message: string };
        const response = await callManager.continueCall(call_id, message);

        return {
          content: [{ type: 'text', text: `User's response:\n${response}` }],
        };
      }

      if (request.params.name === 'speak_to_user') {
        const { call_id, message } = request.params.arguments as { call_id: string; message: string };
        await callManager.speakOnly(call_id, message);

        return {
          content: [{ type: 'text', text: `Message spoken: "${message}"` }],
        };
      }

      if (request.params.name === 'end_call') {
        const { call_id, message } = request.params.arguments as { call_id: string; message: string };
        const { durationSeconds } = await callManager.endCall(call_id, message);

        return {
          content: [{ type: 'text', text: `Call ended. Duration: ${durationSeconds}s` }],
        };
      }

      throw new Error(`Unknown tool: ${request.params.name}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error: ${errorMessage}` }],
        isError: true,
      };
    }
  });

  // Connect MCP server via stdio
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  console.error('');
  console.error('CallMe MCP server ready');
  console.error(`Phone: ${serverConfig.phoneNumber} -> ${serverConfig.userPhoneNumber}`);
  console.error(`Providers: phone=${serverConfig.providers.phone.name}, tts=${serverConfig.providers.tts.name}, stt=${serverConfig.providers.stt.name}`);
  console.error('');

  // Idempotent graceful shutdown
  let shutdownPromise: Promise<void> | null = null;
  const shutdownOnce = (reason: string, exitCode = 0): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        console.error(`\nShutting down (${reason})...`);
        await callManager.shutdown();
        await stopNgrok();
        process.exit(exitCode);
      })();
    }
    return shutdownPromise;
  };

  process.on('SIGINT', () => shutdownOnce('SIGINT'));
  process.on('SIGTERM', () => shutdownOnce('SIGTERM'));
  process.on('SIGHUP', () => shutdownOnce('SIGHUP'));
  process.stdin.on('close', () => shutdownOnce('stdin closed'));
  process.stdin.on('end', () => shutdownOnce('stdin ended'));
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    shutdownOnce('uncaughtException', 1);
  });
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
    shutdownOnce('unhandledRejection', 1);
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
