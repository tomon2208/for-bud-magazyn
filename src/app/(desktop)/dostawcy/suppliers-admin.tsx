"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Field, NoticeBox } from "@/components/form-parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { callApi, useApiAction, zodFieldErrors } from "@/lib/api-client";
import { createSupplierSchema } from "@/lib/validation/catalog";
import type { SupplierDto } from "@/server/catalog";

const TEXTAREA_CLASS =
  "min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function SuppliersAdmin({ suppliers }: { suppliers: SupplierDto[] }) {
  const { run, busy, notice, setNotice } = useApiAction();
  const [editing, setEditing] = useState<SupplierDto | "new" | null>(null);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return suppliers.filter(
      (s) =>
        (showInactive || s.active) &&
        (q === "" || s.name.toLowerCase().includes(q) || (s.contactPerson ?? "").toLowerCase().includes(q)),
    );
  }, [suppliers, search, showInactive]);

  function toggleActive(s: SupplierDto) {
    if (s.active && !window.confirm(`Dezaktywować dostawcę ${s.name}? Nie będzie można go wybrać dla nowych materiałów.`)) {
      return;
    }
    void run(
      () => callApi(`/api/v1/suppliers/${s.id}`, "PATCH", { active: !s.active }),
      s.active ? `Dezaktywowano ${s.name}` : `Aktywowano ${s.name}`,
    );
  }

  return (
    <div className="space-y-6">
      {editing ? (
        <SupplierForm
          key={editing === "new" ? "new" : editing.id}
          supplier={editing === "new" ? null : editing}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSubmit={async (data) => {
            const isNew = editing === "new";
            const result = await run(
              () =>
                isNew
                  ? callApi("/api/v1/suppliers", "POST", data)
                  : callApi(`/api/v1/suppliers/${(editing as SupplierDto).id}`, "PATCH", data),
              isNew ? `Dodano dostawcę ${data.name}` : `Zapisano dostawcę ${data.name}`,
            );
            if (result?.ok) setEditing(null);
            return result;
          }}
        />
      ) : (
        <Button type="button" onClick={() => (setNotice(null), setEditing("new"))}>
          Dodaj dostawcę
        </Button>
      )}

      <NoticeBox notice={notice} />

      <div className="flex flex-wrap items-center gap-4">
        <Input
          type="search"
          aria-label="Szukaj dostawcy"
          placeholder="Szukaj po nazwie lub osobie kontaktowej"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-9 w-80"
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Pokaż nieaktywnych
        </label>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-xl border p-6 text-center text-muted-foreground">
          {suppliers.length === 0 ? "Brak dostawców. Dodaj pierwszego powyżej." : "Brak dostawców spełniających kryteria."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nazwa</TableHead>
                <TableHead>Kontakt</TableHead>
                <TableHead>Telefon</TableHead>
                <TableHead>E-mail</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Akcje</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">
                    {s.name}
                    {s.notes && <div className="max-w-xs truncate text-xs font-normal text-muted-foreground">{s.notes}</div>}
                  </TableCell>
                  <TableCell>{s.contactPerson ?? "—"}</TableCell>
                  <TableCell>{s.phone ?? "—"}</TableCell>
                  <TableCell>{s.email ?? "—"}</TableCell>
                  <TableCell>
                    {s.active ? <Badge variant="secondary">aktywny</Badge> : <Badge variant="destructive">nieaktywny</Badge>}
                  </TableCell>
                  <TableCell className="space-x-2 text-right whitespace-nowrap">
                    <Button type="button" variant="outline" size="lg" disabled={busy} onClick={() => (setNotice(null), setEditing(s))}>
                      Edytuj
                    </Button>
                    <Button
                      type="button"
                      variant={s.active ? "destructive" : "outline"}
                      size="lg"
                      disabled={busy}
                      onClick={() => toggleActive(s)}
                    >
                      {s.active ? "Dezaktywuj" : "Aktywuj"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

type SupplierPayload = ReturnType<typeof createSupplierSchema.parse>;

function SupplierForm({
  supplier,
  busy,
  onCancel,
  onSubmit,
}: {
  supplier: SupplierDto | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (data: SupplierPayload) => Promise<{ ok: boolean; fields?: Record<string, string> } | null>;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = createSupplierSchema.safeParse({
      name: form.get("name"),
      contact_person: form.get("contact_person"),
      phone: form.get("phone"),
      email: form.get("email"),
      notes: form.get("notes"),
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    const result = await onSubmit(parsed.data);
    if (result && !result.ok) setErrors(result.fields ?? {});
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{supplier ? `Edycja dostawcy: ${supplier.name}` : "Nowy dostawca"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field id="sup-name" label="Nazwa *" error={errors.name} className="lg:col-span-2">
            <Input id="sup-name" name="name" defaultValue={supplier?.name} maxLength={200} autoComplete="off" aria-invalid={!!errors.name} />
          </Field>
          <Field id="sup-contact" label="Osoba kontaktowa" error={errors.contact_person}>
            <Input id="sup-contact" name="contact_person" defaultValue={supplier?.contactPerson ?? ""} maxLength={120} autoComplete="off" />
          </Field>
          <Field id="sup-phone" label="Telefon" error={errors.phone}>
            <Input id="sup-phone" name="phone" type="tel" defaultValue={supplier?.phone ?? ""} maxLength={50} autoComplete="off" />
          </Field>
          <Field id="sup-email" label="E-mail" error={errors.email} className="lg:col-span-2">
            <Input id="sup-email" name="email" type="email" defaultValue={supplier?.email ?? ""} maxLength={200} autoComplete="off" />
          </Field>
          <Field id="sup-notes" label="Uwagi" error={errors.notes} className="sm:col-span-2">
            <textarea id="sup-notes" name="notes" defaultValue={supplier?.notes ?? ""} maxLength={2000} className={TEXTAREA_CLASS} />
          </Field>
          <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
            <Button type="submit" disabled={busy}>
              {supplier ? "Zapisz zmiany" : "Dodaj dostawcę"}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
              Anuluj
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
