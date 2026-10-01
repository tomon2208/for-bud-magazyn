"use client";

import { useState, type FormEvent } from "react";
import { Field, NoticeBox } from "@/components/form-parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { callApi, useApiAction, zodFieldErrors } from "@/lib/api-client";
import { categoryNameSchema } from "@/lib/validation/catalog";
import type { CategoryDto } from "@/server/catalog";

export function CategoriesAdmin({ categories }: { categories: CategoryDto[] }) {
  const { run, busy, notice } = useApiAction();
  const [createError, setCreateError] = useState<string | undefined>();

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const parsed = categoryNameSchema.safeParse(new FormData(formEl).get("name"));
    if (!parsed.success) {
      setCreateError(parsed.error.issues[0]?.message);
      return;
    }
    setCreateError(undefined);
    const result = await run(
      () => callApi("/api/v1/categories", "POST", { name: parsed.data }),
      `Dodano kategorię ${parsed.data}`,
    );
    if (result?.ok) formEl.reset();
    else if (result && !result.ok) setCreateError(result.fields.name);
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Dodaj kategorię</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreate} noValidate className="flex flex-wrap items-start gap-4">
            <Field id="new-category" label="Nazwa" error={createError} className="w-72">
              <Input id="new-category" name="name" autoComplete="off" maxLength={80} aria-invalid={!!createError} />
            </Field>
            <Button type="submit" disabled={busy} className="mt-[1.625rem]">
              Dodaj kategorię
            </Button>
          </form>
        </CardContent>
      </Card>

      <NoticeBox notice={notice} />

      {categories.length === 0 ? (
        <p className="rounded-xl border p-6 text-center text-muted-foreground">Brak kategorii. Dodaj pierwszą powyżej.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nazwa</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Akcje</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {categories.map((c) => (
                <CategoryRow
                  key={`${c.id}-${c.updatedAt}`}
                  category={c}
                  busy={busy}
                  onPatch={(patch, success) => run(() => callApi(`/api/v1/categories/${c.id}`, "PATCH", patch), success)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function CategoryRow({
  category,
  busy,
  onPatch,
}: {
  category: CategoryDto;
  busy: boolean;
  onPatch: (patch: Record<string, unknown>, success: string) => Promise<{ ok: boolean; fields?: Record<string, string> } | null>;
}) {
  const [name, setName] = useState(category.name);
  const [error, setError] = useState<string | undefined>();

  async function saveName() {
    const parsed = categoryNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(zodFieldErrors(parsed.error.issues)._ ?? parsed.error.issues[0]?.message);
      return;
    }
    setError(undefined);
    const result = await onPatch({ name: parsed.data }, `Zmieniono nazwę kategorii na ${parsed.data}`);
    if (result && !result.ok) setError(result.fields?.name);
  }

  function toggleActive() {
    if (
      category.active &&
      !window.confirm(
        `Dezaktywować kategorię ${category.name}? Nie będzie można jej wybrać dla nowych materiałów (istniejące zostają bez zmian).`,
      )
    ) {
      return;
    }
    void onPatch({ active: !category.active }, category.active ? `Dezaktywowano ${category.name}` : `Aktywowano ${category.name}`);
  }

  return (
    <TableRow>
      <TableCell>
        <div className="flex max-w-sm gap-2">
          <Input
            aria-label={`Nazwa kategorii ${category.name}`}
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={!!error}
            className="h-9"
          />
          {name.trim() !== category.name && (
            <Button type="button" size="lg" disabled={busy} onClick={saveName}>
              Zapisz
            </Button>
          )}
        </div>
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </TableCell>
      <TableCell>
        {category.active ? <Badge variant="secondary">aktywna</Badge> : <Badge variant="destructive">nieaktywna</Badge>}
      </TableCell>
      <TableCell className="text-right">
        <Button
          type="button"
          variant={category.active ? "destructive" : "outline"}
          size="lg"
          disabled={busy}
          onClick={toggleActive}
        >
          {category.active ? "Dezaktywuj" : "Aktywuj"}
        </Button>
      </TableCell>
    </TableRow>
  );
}
