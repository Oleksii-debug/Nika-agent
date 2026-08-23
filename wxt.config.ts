import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Nika Agent',
    description: 'Local browser workflow orchestrator for ChatGPT web chats.',
    permissions: ['alarms', 'storage', 'tabs', 'scripting', 'clipboardWrite'],
    host_permissions: ['https://chatgpt.com/*'],
    action: {
      default_title: 'Nika Agent',
    },
  },
});
