import { z } from 'zod'
import { defineResponseContract, openEnum } from '../../boundary'
import { personRefReader } from './person'
import { conversationModes, conversationSettingRead, conversationSettingInput } from './schema/schemas'
import { conversationSettingOperations } from './schema/conversation-setting-operations'

export const conversationSettingReader = conversationSettingRead.strip().extend({
  mode: openEnum(conversationModes), updatedBy: personRefReader.optional(),
})
export const conversationSettingContracts = {
  get: defineResponseContract({ ...conversationSettingOperations.get, source: 'console', reader: conversationSettingReader }),
  put: defineResponseContract({ ...conversationSettingOperations.put, source: 'console', reader: conversationSettingReader }),
}
export type ConversationSetting = z.output<typeof conversationSettingReader>
export type ConversationSettingInput = z.input<typeof conversationSettingInput>
