"use client";

import { useState } from "react";
import { NoticeBox } from "@/components/form-parts";
import { Button } from "@/components/ui/button";
import { callApi, useApiAction } from "@/lib/api-client";
import { ORDER_STATUS_LABELS, type OrderStatus } from "@/lib/validation/orders";
import type { OrderDto } from "@/server/orders";
import { OrderForm, StatusBadge, StatusButtons, statusChangeQuestion } from "../orders-view";

const DATE = new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Warsaw" });

/** Nagłówek zlecenia: nazwa, numer, status, notatka + edycja danych i zmiana statusu (z potwierdzeniem). */
export function OrderHeader({ order }: { order: OrderDto }) {
  const { run, busy, notice, setNotice } = useApiAction();
  const [editing, setEditing] = useState(false);

  function setStatus(status: OrderStatus) {
    const question = statusChangeQuestion(order.name, status);
    if (question && !window.confirm(question)) return;
    void run(() => callApi(`/api/v1/orders/${order.id}`, "PATCH", { status }), `Zlecenie: ${ORDER_STATUS_LABELS[status].toLowerCase()}`);
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold">
          {order.number && <span className="font-mono text-xl text-muted-foreground">{order.number}</span>}
          {order.name} <StatusBadge status={order.status} />
        </h1>
        <p className="text-sm text-muted-foreground">Utworzono {DATE.format(new Date(order.createdAt))}</p>
        {order.notes && <p className="max-w-3xl text-sm whitespace-pre-line">{order.notes}</p>}
      </div>
      <NoticeBox notice={notice} />
      {editing ? (
        <OrderForm
          order={order}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSubmit={async (data) => {
            const result = await run(() => callApi(`/api/v1/orders/${order.id}`, "PATCH", data), `Zapisano zlecenie „${data.name}”`);
            if (result?.ok) setEditing(false);
            return result;
          }}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="lg" disabled={busy} onClick={() => (setNotice(null), setEditing(true))}>
            Edytuj dane
          </Button>
          <StatusButtons status={order.status} busy={busy} onChange={setStatus} />
        </div>
      )}
    </div>
  );
}
