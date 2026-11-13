// The create paths' calls (wizard and build binding). Every answer is decoded
// at the boundary: Platform answers by contracts/platform/catalog.ts, Console
// answers by the W1 Console contracts. A write whose 2xx answer cannot be read
// rejects with a ResponseContractError (outcome `write_unconfirmed`): the write
// may have happened, so callers read back instead of sending it again.
import type { BusinessApp, Resolved } from '../model/contracts/console'
import type {
  SourceRepository,
  SourceRepositoryList,
  SourceRepositoryRequest,
  SourceRepositoryValidation,
  StackIdentity,
  StackRequest,
  StackValidation,
} from '../model/contracts/catalog'
import {
  createSourceRepositoryContract,
  createStackContract,
  listSourceRepositoriesContract,
  listStacksContract,
  validateSourceRepositoryContract,
  validateStackContract,
} from './contracts/platform/catalog'
import { deleteApplicationSourceRepositoryContract } from './contracts/platform/app'
import {
  appContract,
  appsContract,
  bindAppContract,
  createAppContract,
  removeAppContract,
  resolveContract,
  updateAppContract,
  type CreateAppInput,
  type UpdateAppInput,
} from './contracts/console/operations'
import { apiGateway, type ApiGateway } from './gateway'

export type { CreateAppInput, UpdateAppInput }

export interface CreateApi {
  /** Console apps of the caller (`scope=mine`): the readback for an unconfirmed create. */
  myApps(): Promise<BusinessApp[]>
  app(appId: string): Promise<BusinessApp>
  createApp(input: CreateAppInput): Promise<BusinessApp>
  updateApp(appId: string, input: UpdateAppInput): Promise<BusinessApp>
  bindApp(appId: string, binding: { stackId: string; appName: string }): Promise<BusinessApp>
  removeApp(appId: string): Promise<void>
  resolve(path: string): Promise<Resolved>
  stacks(projectId: string): Promise<StackIdentity[]>
  sourceRepositories(projectId: string): Promise<SourceRepositoryList>
  validateSourceRepository(projectId: string, request: SourceRepositoryRequest): Promise<SourceRepositoryValidation>
  /** `idempotencyKey`: the attempt's key; a resend with it is replayed by Platform, never applied twice. */
  createSourceRepository(projectId: string, request: SourceRepositoryRequest, idempotencyKey: string): Promise<SourceRepository>
  deleteSourceRepository(projectId: string, id: string): Promise<void>
  validateStack(projectId: string, request: StackRequest): Promise<StackValidation>
  createStack(projectId: string, request: StackRequest, idempotencyKey: string): Promise<StackIdentity>
}

/** The create calls over `gateway` (tests pass a gateway over in-memory transports). */
export function createCreateApi(gateway: ApiGateway): CreateApi {
  return {
    myApps: () => gateway.console(appsContract, { scope: 'mine' }),
    app: (appId) => gateway.console(appContract, appId),
    createApp: (input) => gateway.console(createAppContract, input),
    updateApp: (appId, input) => gateway.console(updateAppContract, { appId, input }),
    bindApp: (appId, binding) => gateway.console(bindAppContract, { appId, ...binding }),
    removeApp: (appId) => gateway.console(removeAppContract, appId),
    resolve: (path) => gateway.console(resolveContract, path),
    stacks: async (projectId) => (await gateway.platform(listStacksContract, { projectId })).data,
    sourceRepositories: (projectId) => gateway.platform(listSourceRepositoriesContract, { projectId }),
    validateSourceRepository: (projectId, request) => gateway.platform(validateSourceRepositoryContract, { projectId, ...request }),
    createSourceRepository: (projectId, request, idempotencyKey) => gateway.platform(createSourceRepositoryContract, { projectId, ...request }, { idempotencyKey }),
    deleteSourceRepository: async (projectId, id) => { await gateway.platform(deleteApplicationSourceRepositoryContract, { params: { projectId, id } }) },
    validateStack: (projectId, request) => gateway.platform(validateStackContract, { projectId, ...request }),
    createStack: (projectId, request, idempotencyKey) => gateway.platform(createStackContract, { projectId, ...request }, { idempotencyKey }),
  }
}

export const createApi = createCreateApi(apiGateway)
