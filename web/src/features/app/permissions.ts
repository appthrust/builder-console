import { canManageGroup, isUnknownPerson, type BusinessApp, type Me } from '../../model/contracts/console'

/**
 * Owners, managers of the owning group (inherited management included), and console admins may edit.
 * An owner the server can no longer resolve grants nothing.
 */
export function canEditApp(app: Pick<BusinessApp, 'owners' | 'group'>, me: Me | undefined): boolean {
  if (!me) return false
  return app.owners.some((owner) => !isUnknownPerson(owner) && owner.id === me.person.id) || canManageGroup(me, app.group.id)
}
