#!/usr/bin/env node
// gmail-multi-mcp — MCP server exposing several Google Workspace accounts at once.
//
// Multi-account is modelled as an `account` parameter on every tool rather than one
// server per account, because Claude keys custom connectors by URL alone and refuses
// a second connector pointing at the same server.
//
// Sending is OFF by default. Routines run unattended with no approval step, so the
// send tools only register when GMAIL_MULTI_ALLOW_SEND=1.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { loadAccounts } from './oauth.js';
import * as gmail from './gmail.js';

const ALLOW_SEND = process.env.GMAIL_MULTI_ALLOW_SEND === '1';

const accounts = await loadAccounts();
const accountKeys = Object.keys(accounts);

const server = new McpServer(
  { name: 'gmail-multi-mcp', version: '0.1.0' },
  {
    instructions:
      `Gmail access across ${accountKeys.length} separate Google Workspace accounts: ` +
      accountKeys.map((k) => `"${k}" (${accounts[k].email})`).join(', ') +
      `. Every tool takes an "account" argument naming which one to act on. ` +
      `To send or draft as an alias, pass "from" — it is validated against that ` +
      `account's verified send-as list and rejected if not usable. ` +
      (ALLOW_SEND
        ? 'Sending is enabled.'
        : 'Sending is DISABLED; create drafts for a human to review and send.'),
  }
);

/** Wrap a handler so results and errors both come back as readable text. */
function tool(name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      const { account, ...rest } = args;
      const ctx = { accounts, key: account };
      if (!accounts[account]) {
        throw new Error(
          `Unknown account "${account}". Available: ${accountKeys.join(', ')}`
        );
      }
      const result = await handler(ctx, rest);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });
}

const accountArg = z
  .enum(accountKeys.length ? accountKeys : ['none'])
  .describe('Which configured account to act on');

const addressList = z.array(z.string()).optional().describe('Plain email addresses');

// --- discovery ------------------------------------------------------------

server.registerTool(
  'list_accounts',
  {
    title: 'List accounts',
    description:
      'List the configured Google Workspace accounts and their keys. Call this first if unsure which account to use.',
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          accountKeys.map((k) => ({ account: k, email: accounts[k].email })),
          null,
          2
        ),
      },
    ],
  })
);

tool(
  'list_send_as',
  {
    title: 'List send-as addresses',
    description:
      'List the send-as identities on an account, showing which are verified and therefore usable as a "from" value.',
    inputSchema: { account: accountArg },
  },
  (ctx) => gmail.listSendAs(ctx, { force: true })
);

// --- reading --------------------------------------------------------------

tool(
  'search_messages',
  {
    title: 'Search messages',
    description:
      'Search an account\'s mail using Gmail query syntax (e.g. "is:unread from:someone@x.com newer_than:7d"). Returns message metadata.',
    inputSchema: {
      account: accountArg,
      query: z.string().describe('Gmail search query'),
      maxResults: z.number().int().min(1).max(50).optional().default(20),
    },
  },
  (ctx, a) => gmail.searchMessages(ctx, a)
);

tool(
  'get_message',
  {
    title: 'Get message',
    description: 'Fetch one message in full, including its plain-text and HTML bodies.',
    inputSchema: { account: accountArg, id: z.string().describe('Message id') },
  },
  (ctx, a) => gmail.getMessage(ctx, a)
);

tool(
  'get_thread',
  {
    title: 'Get thread',
    description: 'Fetch every message in a thread, in order.',
    inputSchema: { account: accountArg, id: z.string().describe('Thread id') },
  },
  (ctx, a) => gmail.getThread(ctx, a)
);

// --- drafts ---------------------------------------------------------------

tool(
  'list_drafts',
  {
    title: 'List drafts',
    description: 'List drafts on an account, optionally filtered by a Gmail query.',
    inputSchema: {
      account: accountArg,
      query: z.string().optional(),
      maxResults: z.number().int().min(1).max(50).optional().default(20),
    },
  },
  (ctx, a) => gmail.listDrafts(ctx, a)
);

tool(
  'create_draft',
  {
    title: 'Create draft',
    description:
      'Create a draft. Pass "from" to draft as a verified send-as alias — it is checked against the account\'s send-as list first, because Gmail silently substitutes the primary address for an unverified one. Pass "replyToMessageId" to reply in-thread; threading headers and the Re: subject are derived automatically.',
    inputSchema: {
      account: accountArg,
      from: z
        .string()
        .optional()
        .describe('Send-as address to draft from. Defaults to the account default.'),
      to: addressList,
      cc: addressList,
      bcc: addressList,
      subject: z.string().optional(),
      text: z.string().optional().describe('Plain-text body'),
      html: z.string().optional().describe('HTML body; sent as an alternative to text'),
      replyToMessageId: z.string().optional().describe('Message id to reply to'),
    },
  },
  (ctx, a) => gmail.createDraft(ctx, a)
);

tool(
  'update_draft',
  {
    title: 'Update draft',
    description:
      'Update an existing draft. Only the fields you pass change; everything else is preserved, including thread linkage. The draftId stays stable across updates even though the underlying message id changes.',
    inputSchema: {
      account: accountArg,
      draftId: z.string().describe('Draft id (stable across updates)'),
      from: z.string().optional(),
      to: addressList,
      cc: addressList,
      bcc: addressList,
      subject: z.string().optional(),
      text: z.string().optional(),
      html: z.string().optional(),
    },
  },
  (ctx, a) => gmail.updateDraft(ctx, a)
);

// --- sending (opt-in) -----------------------------------------------------

if (ALLOW_SEND) {
  tool(
    'send_draft',
    {
      title: 'Send draft',
      description: 'Send an existing draft as-is. Irreversible.',
      inputSchema: { account: accountArg, draftId: z.string() },
    },
    (ctx, a) => gmail.sendDraft(ctx, a)
  );

  tool(
    'send_message',
    {
      title: 'Send message',
      description:
        'Compose and send immediately. Irreversible — prefer create_draft unless the user explicitly asked to send.',
      inputSchema: {
        account: accountArg,
        from: z.string().optional(),
        to: addressList,
        cc: addressList,
        bcc: addressList,
        subject: z.string().optional(),
        text: z.string().optional(),
        html: z.string().optional(),
        replyToMessageId: z.string().optional(),
      },
    },
    (ctx, a) => gmail.sendMessage(ctx, a)
  );
}

await server.connect(new StdioServerTransport());
