// Tipos del subpath de @dotrino/update que usa este servicio: el paquete es JS sin .d.ts.
declare module '@dotrino/update/checkout' {
  export function watchCheckout(opts: {
    dir: string
    repo: string
    branch?: string
    name?: string
    log?: (line: string) => void
    everyMs?: number
  }): () => void
}
