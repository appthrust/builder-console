import { ChevronLeft, ChevronRight, ImagePlus, Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { isConsoleError, screenshotUrl } from '../../api/console'
import { type Screenshot } from '../../model/contracts/console'
import { ActionError, Button, ConfirmDialog, Dialog, Field, IconButton, Notice, TextInput } from '../../ui'
import { text } from './copy'
import { useAppReadBack, useRemoveScreenshot, useReorderScreenshots, useUploadScreenshot } from './mutations'
import { isUnconfirmedWrite, UnconfirmedNotice, useWriteConfirmation } from './notices'

export const MAX_SCREENSHOTS = 5
export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024
const MAX_CAPTION_LENGTH = 100
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const THUMB_HEIGHT = 220
const THUMB_MIN_WIDTH = 120
const THUMB_MAX_WIDTH = 560

/** Checks the browser can do before uploading; the server re-checks the bytes themselves. */
export function screenshotFileProblem(file: Pick<File, 'type' | 'size'>, count: number): string | undefined {
  if (count >= MAX_SCREENSHOTS) return text.screenshots.tooMany
  if (!ACCEPTED_TYPES.includes(file.type)) return text.screenshots.wrongType
  if (file.size > MAX_SCREENSHOT_BYTES) return text.screenshots.tooLarge
  return undefined
}

/** Japanese text for the upload's known refusals; undefined lets ActionError explain anything else. */
export function screenshotErrorText(error: unknown): string | undefined {
  if (!isConsoleError(error)) return undefined
  if (error.status === 409) return text.screenshots.tooMany
  if (error.status === 400 || error.status === 413) return text.screenshots.rejected
  return undefined
}

/** The ids with the screenshot at `index` moved one place (`delta` -1 or +1); unchanged at either end. */
export function moveScreenshot(ids: readonly string[], index: number, delta: -1 | 1): string[] {
  const target = index + delta
  const order = [...ids]
  if (index < 0 || index >= order.length || target < 0 || target >= order.length) return order
  ;[order[index], order[target]] = [order[target]!, order[index]!]
  return order
}

/** Fixed-height thumbnail width that keeps the picture's shape, within bounds for very wide or tall screens. */
export function thumbWidth(shot: Pick<Screenshot, 'width' | 'height'>): number {
  const natural = Math.round((THUMB_HEIGHT * shot.width) / shot.height)
  return Math.min(THUMB_MAX_WIDTH, Math.max(THUMB_MIN_WIDTH, natural))
}

/**
 * The app page's picture strip (store-ux §3.4): horizontal thumbnails, a large
 * view with ←/→, and for owners add / remove / reorder. Viewers with no
 * pictures see nothing at all.
 */
export function ScreenshotStrip({ appId, screenshots, canEdit }: { appId: string; screenshots: Screenshot[]; canEdit: boolean }) {
  const headingId = useId()
  const fileInput = useRef<HTMLInputElement>(null)
  const [viewing, setViewing] = useState<number>()
  const [removing, setRemoving] = useState<Screenshot>()
  const [picked, setPicked] = useState<File>()
  const [problem, setProblem] = useState<string>()
  const [added, setAdded] = useState(false)
  const remove = useRemoveScreenshot(appId)
  const reorder = useReorderScreenshots(appId)
  // A change whose answer could not be read may have happened: the app (and its pictures) is read back before another.
  const confirmation = useWriteConfirmation([remove.error, reorder.error], () => { remove.reset(); reorder.reset() }, useAppReadBack(appId))
  const busy = remove.isPending || reorder.isPending || confirmation.unconfirmed
  const ids = screenshots.map((shot) => shot.id)
  const room = screenshots.length < MAX_SCREENSHOTS

  if (screenshots.length === 0 && !canEdit) return null

  // Opened from the click itself so the browser treats it as the user's choice.
  const pick = () => {
    setAdded(false)
    fileInput.current?.click()
  }
  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const found = screenshotFileProblem(file, screenshots.length)
    setProblem(found)
    setPicked(found ? undefined : file)
  }
  const addButton = (
    <Button size="sm" icon={<ImagePlus />} onClick={pick}>{text.screenshots.add}</Button>
  )

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={headingId} className={canEdit ? 'text-base font-semibold text-stone-900' : 'sr-only'}>{text.screenshots.label}</h2>
        {canEdit ? <p className="text-xs text-stone-500">{text.screenshots.count(screenshots.length)}・{text.screenshots.limits}</p> : null}
      </div>
      {canEdit ? (
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPTED_TYPES.join(',')}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={choose}
        />
      ) : null}

      {screenshots.length === 0 && !picked ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-stone-300 bg-white px-6 py-10 text-center">
          <ImagePlus aria-hidden className="size-6 text-stone-400" />
          <p className="max-w-sm text-sm text-stone-600">{text.screenshots.emptyOwner}</p>
          {addButton}
        </div>
      ) : null}

      {screenshots.length > 0 ? (
        <ul className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pt-1 pb-3">
          {screenshots.map((shot, index) => {
            const name = shot.caption || text.screenshots.nth(index + 1)
            const width = thumbWidth(shot)
            return (
              <li key={shot.id} className="max-w-[80vw] shrink-0 snap-start" style={{ width }}>
                <figure>
                  <button
                    type="button"
                    onClick={() => setViewing(index)}
                    aria-label={text.screenshots.open(name)}
                    className="block w-full overflow-hidden rounded-lg border border-stone-200 bg-stone-100 transition hover:border-stone-300 hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    <img
                      src={screenshotUrl(appId, shot.id)}
                      alt=""
                      width={width}
                      height={THUMB_HEIGHT}
                      loading="lazy"
                      decoding="async"
                      className="block w-full object-cover"
                      style={{ height: THUMB_HEIGHT }}
                    />
                  </button>
                  {shot.caption ? <figcaption className="mt-1.5 truncate text-xs text-stone-600" title={shot.caption}>{shot.caption}</figcaption> : null}
                </figure>
                {canEdit ? (
                  <div className="mt-1 flex items-center gap-1">
                    <IconButton label={text.screenshots.moveEarlier(index + 1)} icon={<ChevronLeft />} disabled={busy || index === 0} onClick={() => reorder.mutate(moveScreenshot(ids, index, -1))} />
                    <IconButton label={text.screenshots.moveLater(index + 1)} icon={<ChevronRight />} disabled={busy || index === screenshots.length - 1} onClick={() => reorder.mutate(moveScreenshot(ids, index, 1))} />
                    <IconButton
                      label={text.screenshots.remove(index + 1)}
                      icon={<Trash2 />}
                      className="ml-auto text-bad-ink hover:bg-bad-soft hover:text-bad-ink"
                      disabled={busy}
                      onClick={() => {
                        remove.reset()
                        setRemoving(shot)
                      }}
                    />
                  </div>
                ) : null}
              </li>
            )
          })}
          {canEdit && room && !picked ? (
            <li className="shrink-0 snap-start">
              <button
                type="button"
                onClick={pick}
                className="flex w-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-stone-300 bg-white text-sm text-stone-600 hover:border-stone-400 hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                style={{ height: THUMB_HEIGHT }}
              >
                <ImagePlus aria-hidden className="size-5 text-stone-400" />
                {text.screenshots.add}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}

      {canEdit && !room ? <p className="text-xs text-stone-500">{text.screenshots.full}</p> : null}
      {problem ? <Notice tone="error">{problem}</Notice> : null}
      {confirmation.unconfirmed ? <UnconfirmedNotice onConfirm={() => void confirmation.confirm()} confirming={confirmation.confirming} /> : reorder.error ? <ActionError error={reorder.error} /> : null}
      {added ? <p role="status" className="text-sm text-accent-strong">{text.screenshots.added}</p> : null}

      {canEdit && picked ? (
        <ScreenshotUpload
          key={`${picked.name}-${picked.lastModified}-${picked.size}`}
          appId={appId}
          file={picked}
          onChooseAgain={pick}
          onDone={() => {
            setPicked(undefined)
            setAdded(true)
          }}
          onCancel={() => setPicked(undefined)}
        />
      ) : null}

      <ScreenshotViewer appId={appId} screenshots={screenshots} index={viewing} onIndexChange={setViewing} />

      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setRemoving(undefined)
            if (!confirmation.unconfirmed) remove.reset()
          }
        }}
        title={text.screenshots.removeTitle}
        body={removing ? (
          <div className="space-y-3">
            <img src={screenshotUrl(appId, removing.id)} alt="" className="max-h-40 rounded-md border border-stone-200 object-contain" />
            <p>{text.screenshots.removeBody}</p>
          </div>
        ) : null}
        tone="danger"
        confirmLabel={text.screenshots.removeConfirm}
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => {
          if (!removing || remove.isPending) return
          remove.mutate(removing.id, { onSuccess: () => setRemoving(undefined), onError: (error) => { if (isUnconfirmedWrite(error)) setRemoving(undefined) } })
        }}
      />
    </section>
  )
}

/** Large view of one picture; ←/→ step through the strip while it is open. */
function ScreenshotViewer({ appId, screenshots, index, onIndexChange }: {
  appId: string
  screenshots: Screenshot[]
  index: number | undefined
  onIndexChange: (index: number | undefined) => void
}) {
  const shot = index === undefined ? undefined : screenshots[index]
  const total = screenshots.length
  useEffect(() => {
    if (index === undefined || total < 2) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') onIndexChange((index - 1 + total) % total)
      if (event.key === 'ArrowRight') onIndexChange((index + 1) % total)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, total, onIndexChange])

  return (
    <Dialog
      open={shot !== undefined}
      onOpenChange={(open) => {
        if (!open) onIndexChange(undefined)
      }}
      title={shot?.caption || text.screenshots.label}
      description={index !== undefined && total > 1 ? text.screenshots.of(index + 1, total) : undefined}
      className="sm:max-w-5xl"
    >
      {shot && index !== undefined ? (
        <div className="space-y-4">
          <img
            src={screenshotUrl(appId, shot.id)}
            alt={shot.caption || text.screenshots.nth(index + 1)}
            width={shot.width}
            height={shot.height}
            className="mx-auto block h-auto max-h-[70dvh] w-auto max-w-full rounded-md border border-stone-200 bg-stone-50 object-contain"
          />
          {total > 1 ? (
            <div className="flex items-center justify-between gap-3">
              <Button size="sm" icon={<ChevronLeft />} onClick={() => onIndexChange((index - 1 + total) % total)}>{text.screenshots.previous}</Button>
              <Button size="sm" onClick={() => onIndexChange((index + 1) % total)}>
                {text.screenshots.next}
                <ChevronRight aria-hidden />
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  )
}

/** The chosen picture, an optional caption, then upload. */
function ScreenshotUpload({ appId, file, onChooseAgain, onDone, onCancel }: {
  appId: string
  file: File
  onChooseAgain: () => void
  onDone: () => void
  onCancel: () => void
}) {
  const id = useId()
  const upload = useUploadScreenshot(appId)
  const confirmation = useWriteConfirmation([upload.error], upload.reset, useAppReadBack(appId))
  const [preview, setPreview] = useState<string>()
  const [caption, setCaption] = useState('')
  const captionTooLong = Array.from(caption.trim()).length > MAX_CAPTION_LENGTH
  const uploadError = upload.error ? screenshotErrorText(upload.error) : undefined

  // The object URL must be created inside the effect so StrictMode's simulated unmount revokes
  // only its own URL and the re-run creates a fresh one; a memoised URL would be revoked for good.
  useEffect(() => {
    const url = URL.createObjectURL(file)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- object URL lifetime is bound to this effect.
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (captionTooLong || upload.isPending || confirmation.unconfirmed) return
    upload.mutate({ file, caption: caption.trim() || undefined }, { onSuccess: onDone })
  }

  return (
    <form onSubmit={submit} aria-labelledby={`${id}-title`} className="space-y-4 rounded-lg border border-stone-200 bg-white p-4">
      <h3 id={`${id}-title`} className="text-sm font-semibold text-stone-900">{text.screenshots.addTitle}</h3>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="shrink-0 space-y-2 sm:w-56">
          <div className="flex h-36 items-center justify-center overflow-hidden rounded-md border border-stone-200 bg-stone-50">
            {preview ? <img src={preview} alt="" className="h-full w-full object-contain" /> : null}
          </div>
          <Button size="sm" tone="ghost" onClick={onChooseAgain} disabled={upload.isPending}>{text.screenshots.chooseAgain}</Button>
        </div>
        <Field
          id={`${id}-caption`}
          label={text.screenshots.caption}
          hint={text.screenshots.captionHint}
          error={captionTooLong ? text.screenshots.captionTooLong : undefined}
          className="min-w-0 flex-1"
        >
          <TextInput id={`${id}-caption`} value={caption} invalid={captionTooLong} onChange={(event) => setCaption(event.target.value)} autoComplete="off" autoFocus />
        </Field>
      </div>
      {confirmation.unconfirmed ? <UnconfirmedNotice onConfirm={() => void confirmation.confirm()} confirming={confirmation.confirming} /> : upload.error ? uploadError ? <Notice tone="error">{uploadError}</Notice> : <ActionError error={upload.error} /> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onCancel} disabled={upload.isPending}>{text.screenshots.cancel}</Button>
        <Button type="submit" tone="primary" loading={upload.isPending} disabled={captionTooLong || confirmation.unconfirmed}>{text.screenshots.upload}</Button>
      </div>
    </form>
  )
}
