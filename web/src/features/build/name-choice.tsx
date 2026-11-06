import { useForm, useStore } from '@tanstack/react-form'
import { useEffect, useRef, useState } from 'react'
import { isValidAppName } from '../../model/create'
import { Button, Field, TextInput } from '../../ui'
import { text } from './copy'

/** A name collision changes the existing plan, not the user's specification. */
export function NameChoice({ suggestion, onUse }: { suggestion?: string; onUse(name: string): void }) {
  const [editing, setEditing] = useState(!suggestion)
  const input = useRef<HTMLInputElement>(null)
  const form = useForm({ defaultValues: { name: suggestion ?? '' }, onSubmit: ({ value }) => { if (isValidAppName(value.name)) onUse(value.name) } })
  const name = useStore(form.store, (state) => state.values.name)
  useEffect(() => { if (editing) input.current?.focus() }, [editing])
  return <div className="w-full space-y-3">
    {suggestion ? <Button onClick={() => onUse(suggestion)}>{text.nameChoice.useSuggestion(suggestion)}</Button> : null}
    {!editing ? <Button className="ml-2" tone="ghost" onClick={() => setEditing(true)}>{text.nameChoice.alternative}</Button> : <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit() }} className="space-y-3">
      <form.Field name="name">{(field) => <Field id="build-alternative-name" label={text.nameChoice.alternative} hint={text.nameChoice.hint}><TextInput id="build-alternative-name" ref={input} value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} autoComplete="off" maxLength={63} /></Field>}</form.Field>
      <Button type="submit" disabled={!isValidAppName(name)}>{text.nameChoice.submit}</Button>
    </form>}
  </div>
}
