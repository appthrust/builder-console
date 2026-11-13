import { canManageGroup, type Me } from '../../model/contracts/console'
import { type BusinessApp } from '../../api/console-unverified'

/** Owners, managers of the owning group (inherited management included), and console admins may edit. */
export function canEditApp(app: BusinessApp, me: Me | undefined): boolean {
  if (!me) return false
  return app.owners.some((owner) => owner.id === me.person.id) || canManageGroup(me, app.group.id)
}
