import type { ImportItemPayload } from "./resolve";

// Budowa treści zapisu importu i klucza idempotencji (czyste funkcje, bez Reacta) — wzorzec M1 z ADR 013:
// identyczna treść → ten sam client_request_id (ponowienie po błędzie sieci nie dubluje listy), zmiana → nowy.

export type ImportSaveInput = {
  /** Zlecenie docelowe; null → nowe zlecenie (orderName / orderNumber). */
  targetOrderId: string | null;
  orderName: string;
  orderNumber: string;
  listName: string;
  fileName: string;
  formatId: string;
  items: readonly ImportItemPayload[];
};

export type ImportSaveBody = {
  order_id?: string;
  new_order?: { name: string; number: string };
  name: string;
  file_name: string;
  import_format: string;
  items: ImportItemPayload[];
};

/** Treść żądania (bez client_request_id) i klucz identyfikujący JEJ ZAWARTOŚĆ. */
export function buildImportPayload(input: ImportSaveInput): { body: ImportSaveBody; key: string } {
  const body: ImportSaveBody = {
    ...(input.targetOrderId
      ? { order_id: input.targetOrderId }
      : { new_order: { name: input.orderName, number: input.orderNumber } }),
    name: input.listName,
    file_name: input.fileName,
    import_format: input.formatId,
    items: input.items.map((i) => ({ material_id: i.material_id, quantity: i.quantity, raw_source_ref: i.raw_source_ref })),
  };
  return { body, key: JSON.stringify(body) };
}

export type RequestIdState = { key: string; id: string } | null;

/** Zwraca poprzedni identyfikator, gdy treść się nie zmieniła; inaczej nowy. */
export function requestIdFor(prev: RequestIdState, key: string, newId: () => string): { key: string; id: string } {
  return prev && prev.key === key ? prev : { key, id: newId() };
}
