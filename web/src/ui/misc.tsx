import { useQueryClient } from '@tanstack/react-query'
import { Check, Copy } from 'lucide-react'
import { useEffect, useState, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { avatarUrl, consoleKeys, directoryLinks, type Me } from '../api/console'
import { copy } from '../copy'
import { paths } from '../routes/paths'
import { Button, IconButton, type ButtonSize, type ButtonTone } from './button'
import { cn } from './cn'
import { HrefLink } from './link'

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-stone-300 bg-stone-50 px-1 font-mono text-[11px] text-stone-600">
      {children}
    </kbd>
  )
}

/** Copies `value` to the clipboard and confirms in place (「コピーしました」, announced politely). */
export function CopyButton({
  value,
  label = copy.common.copy,
  tone = 'secondary',
  size = 'sm',
  className,
  iconOnly = false,
}: {
  value: string
  label?: string
  tone?: ButtonTone
  size?: ButtonSize
  className?: string
  iconOnly?: boolean
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(timer)
  }, [copied])
  const icon = copied ? <Check className="text-accent" /> : <Copy />
  const onCopy = () => {
    void navigator.clipboard.writeText(value).then(() => setCopied(true))
  }
  if (iconOnly) {
    return (
      <>
        <IconButton label={copied ? copy.common.copied : label} tone={tone} size={size} className={className} icon={icon} onClick={onCopy} />
        <span role="status" className="sr-only">{copied ? copy.common.copied : ''}</span>
      </>
    )
  }
  return (
    <Button
      tone={tone}
      size={size}
      className={className}
      icon={icon}
      onClick={onCopy}
    >
      <span aria-live="polite">{copied ? copy.common.copied : label}</span>
    </Button>
  )
}

const ICON_SIZE = { sm: 'size-7 text-sm rounded-md', md: 'size-10 text-lg rounded-lg', lg: 'size-14 text-2xl rounded-xl' } as const

/** Square app icon: the app's emoji/short icon, else the first character of its name. Decorative. */
export function AppIcon({ icon, name, size = 'md' }: { icon: string; name: string; size?: keyof typeof ICON_SIZE }) {
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 items-center justify-center bg-accent-soft font-semibold text-accent-strong ring-1 ring-accent-line ring-inset', ICON_SIZE[size])}
    >
      {icon || Array.from(name)[0] || '・'}
    </span>
  )
}

const AVATAR_SIZE = { sm: 'size-6 text-[11px]', md: 'size-8 text-xs', lg: 'size-14 text-xl' } as const

type AvatarPerson = { id: string; displayName: string; avatarVersion: string | null }

/**
 * A person's profile picture (served by the Directory), else the initial of their name in a neutral
 * circle (also when the picture fails to load or no Directory is linked). Decorative; the name is
 * always shown next to it.
 */
export function Avatar({ person, size = 'md' }: { person: AvatarPerson; size?: keyof typeof AVATAR_SIZE }) {
  const [failedUrl, setFailedUrl] = useState<string>()
  // The root route loads `me` before any page renders; the Directory origin never changes within a session.
  const directoryPublicURL = useQueryClient().getQueryData<Me>(consoleKeys.me)?.directoryPublicURL
  const url = person.avatarVersion && directoryPublicURL ? avatarUrl(directoryPublicURL, person.id, person.avatarVersion) : undefined
  if (url && url !== failedUrl) {
    return (
      <img
        aria-hidden
        alt=""
        src={url}
        loading="lazy"
        decoding="async"
        onError={() => setFailedUrl(url)}
        className={cn('inline-block shrink-0 rounded-full bg-stone-200 object-cover', AVATAR_SIZE[size])}
      />
    )
  }
  return (
    <span aria-hidden className={cn('inline-flex shrink-0 items-center justify-center rounded-full bg-stone-200 font-semibold text-stone-700', AVATAR_SIZE[size])}>
      {Array.from(person.displayName.trim())[0] ?? '?'}
    </span>
  )
}

/**
 * A link to a person's profile. Profiles live in the Directory, another origin,
 * so the link opens there in a new tab and the console page the reader was on
 * stays put (an in-tab hop would leave the app via the `/-/people` redirect).
 * Without a linked Directory it is an ordinary in-console link to the fallback card.
 */
export function PersonLink({ personId, children, ...rest }: { personId: string; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'target' | 'rel' | 'children'>) {
  const directoryPublicURL = useQueryClient().getQueryData<Me>(consoleKeys.me)?.directoryPublicURL
  if (directoryPublicURL) {
    return (
      <a href={directoryLinks.person(directoryPublicURL, personId)} target="_blank" rel="noreferrer noopener" {...rest}>
        {children}
      </a>
    )
  }
  return <HrefLink href={paths.person(personId)} {...rest}>{children}</HrefLink>
}
