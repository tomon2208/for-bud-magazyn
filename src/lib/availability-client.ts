"use client";

import { useEffect, useState } from "react";

// Dostępność materiału z rezerwacjami (Etap 11) w przeglądarce: GET /api/v1/stock/availability.

export type AvailabilityView = {
  stockActive: number;
  reservedTotal: number;
  free: number;
  ownReserved: number;
  availableForIssue: number;
  overReserved: boolean;
};

export async function fetchAvailability(materialId: string, orderId: string | null = null): Promise<AvailabilityView | null> {
  try {
    const params = new URLSearchParams({ materialId, ...(orderId ? { orderId } : {}) });
    const res = await fetch(`/api/v1/stock/availability?${params}`);
    const json = (await res.json().catch(() => null)) as { data?: AvailabilityView } | null;
    return res.ok && json?.data ? json.data : null;
  } catch {
    return null;
  }
}

/** Dostępność materiału (null — nieznana / błąd). Odświeżana przy zmianie materiału albo `reload`. */
export function useMaterialAvailability(materialId: string | null | undefined, reload = 0): AvailabilityView | null {
  const [state, setState] = useState<{ id: string; data: AvailabilityView | null } | null>(null);
  useEffect(() => {
    if (!materialId) return;
    let cancelled = false;
    void fetchAvailability(materialId).then((data) => !cancelled && setState({ id: materialId, data }));
    return () => {
      cancelled = true;
    };
  }, [materialId, reload]);
  return state && state.id === materialId ? state.data : null;
}
