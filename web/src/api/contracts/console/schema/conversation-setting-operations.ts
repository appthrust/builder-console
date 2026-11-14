export const conversationSettingOperations = {
  get: { operationId: 'consoleGetConversationSetting', method: 'GET', routeTemplate: '/api/console/admin/conversation', successStatuses: [200], schema: 'ConversationSetting' },
  put: { operationId: 'consolePutConversationSetting', method: 'PUT', routeTemplate: '/api/console/admin/conversation', successStatuses: [200], schema: 'ConversationSetting', requestSchema: 'ConversationSettingInput', headersSchema: 'ConversationSettingHeaders' },
} as const
