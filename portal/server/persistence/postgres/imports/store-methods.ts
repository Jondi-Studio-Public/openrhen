// A leaf: the import-store methods a provider's private extension adds, such as the diff that reads
// that provider's own link rows. `import-store.ts` installs them on the class once it is defined; each file that
// registers some also augments `PostgresImportStore` with their types. The OpenRhen export's seam is empty, so the
// class there has none.
import type { PostgresImportStore } from "../import-store";

type StoreMethod = (this: PostgresImportStore, ...args: any[]) => unknown;

const methods: Record<string, StoreMethod> = {};

export function registerStoreMethods(added: Record<string, StoreMethod>): void {
  Object.assign(methods, added);
}

export function installStoreMethods(target: object): void {
  for (const [name, method] of Object.entries(methods))
    Object.defineProperty(target, name, { value: method, writable: true, configurable: true });
}
