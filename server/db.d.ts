export interface DbUser {
  id: string
  email: string
  salt: string
  hash: string
  createdAt: string
}

export interface ItemMeta {
  kind: string
  id: string
  name: string
  shapes: number
  updatedAt: string
  size: number
  deleted: boolean
  rev: number
}

export interface Db {
  ready(): Promise<void>
  createUser(u: DbUser): Promise<boolean>
  userByEmail(email: string): Promise<DbUser | null>
  userById(id: string): Promise<DbUser | null>
  deleteUser(id: string): Promise<void>
  listItems(userId: string, since: number, limit: number): Promise<ItemMeta[]>
  getItem(userId: string, kind: string, id: string): Promise<(ItemMeta & { data: string | null }) | null>
  usage(userId: string): Promise<{ bytes: number; items: number }>
  putItem(
    userId: string,
    kind: string,
    id: string,
    item: { name: string; shapes: number; updatedAt: string; data: string; size: number },
    baseRev: number,
  ): Promise<{ rev: number; conflict?: true }>
  deleteItem(userId: string, kind: string, id: string, baseRev: number): Promise<{ rev: number; conflict?: true }>
  hit(key: string, windowSeconds: number): Promise<number>
}

export function createNeonDb(url: string): Db
export function createMemoryDb(): Db
