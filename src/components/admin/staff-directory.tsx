"use client";

import { useRouter } from "next/navigation";
import * as React from "react";

import { setStaffActiveAction } from "@/app/staff/(protected)/manager/staff/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  NO_FILTERS,
  deactivationBlock,
  filterStaff,
  isFiltered,
  sortStaff,
  type RoleFilter,
  type StaffFilters,
  type StaffRow,
  type StatusFilter,
} from "@/lib/staff/directory";

import { ActionButton } from "./action-button";

const dateFormat = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeZone: "Asia/Kolkata",
});

const BLOCK_NOTE = {
  self: "This is you. Another manager must change your account.",
  last_manager: "The only active manager. Make another manager active first.",
} as const;

export function StaffDirectory({
  rows,
  currentUserId,
}: {
  rows: StaffRow[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [filters, setFilters] = React.useState<StaffFilters>(NO_FILTERS);
  // A refused change (someone else got there first) means this list is stale: reload it.
  const refreshIfRefused = (result: { ok: boolean }) => {
    if (!result.ok) router.refresh();
  };
  const sorted = React.useMemo(() => sortStaff(rows), [rows]);
  const visible = React.useMemo(() => filterStaff(sorted, filters), [sorted, filters]);
  const counts = `${visible.length} of ${rows.length} ${rows.length === 1 ? "person" : "people"}`;

  return (
    <section aria-labelledby="directory-title" className="flex flex-col gap-4">
      <h2 id="directory-title" className="sr-only">
        Staff directory
      </h2>
      <form
        role="search"
        aria-label="Filter staff"
        className="grid gap-3 sm:grid-cols-[1fr_auto_auto]"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="staff-search" className="text-sm font-semibold">
            Search name or email
          </label>
          <Input
            id="staff-search"
            type="search"
            autoComplete="off"
            value={filters.query}
            onChange={(event) => setFilters({ ...filters, query: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="staff-role" className="text-sm font-semibold">
            Role
          </label>
          <Select
            id="staff-role"
            value={filters.role}
            onChange={(event) => setFilters({ ...filters, role: event.target.value as RoleFilter })}
          >
            <option value="all">All roles</option>
            <option value="manager">Manager</option>
            <option value="counter">Counter</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="staff-status" className="text-sm font-semibold">
            Status
          </label>
          <Select
            id="staff-status"
            value={filters.status}
            onChange={(event) =>
              setFilters({ ...filters, status: event.target.value as StatusFilter })
            }
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Deactivated</option>
          </Select>
        </div>
      </form>

      <p
        role="status"
        aria-live="polite"
        className="text-sm text-muted-foreground"
        data-testid="staff-count"
      >
        {counts}
      </p>

      {rows.length === 0 ? (
        <div className="rounded-xl border bg-card p-6 text-center" data-testid="staff-empty">
          <p className="font-semibold">No staff accounts yet.</p>
        </div>
      ) : visible.length === 0 ? (
        <div
          className="flex flex-col items-center gap-3 rounded-xl border bg-card p-6 text-center"
          data-testid="staff-no-matches"
        >
          <p className="font-semibold">No one matches those filters.</p>
          {isFiltered(filters) ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setFilters(NO_FILTERS)}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : (
        <ul className="divide-y rounded-xl border bg-card px-4" data-testid="staff-list">
          {visible.map((row) => {
            const block = deactivationBlock(row, currentUserId, rows);
            const isSelf = row.userId === currentUserId;
            return (
              <li
                key={row.userId}
                data-testid="staff-row"
                data-name={row.displayName}
                className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-semibold">{row.displayName}</h3>
                    {isSelf ? <Badge variant="gold">You</Badge> : null}
                    <Badge variant="outline">
                      {row.role === "manager" ? "Manager" : "Counter"}
                    </Badge>
                    {row.isActive ? (
                      <Badge variant="statusReady">Active</Badge>
                    ) : (
                      <Badge variant="statusCancelled">Deactivated</Badge>
                    )}
                  </div>
                  <p className="truncate text-sm text-muted-foreground">
                    {row.email ?? "Email unavailable"}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Added {dateFormat.format(new Date(row.createdAt))}
                  </p>
                </div>
                <div className="flex flex-col items-start gap-1 sm:items-end">
                  {row.isActive ? (
                    <ActionButton
                      action={setStaffActiveAction.bind(null, row.userId, false)}
                      disabled={block !== null}
                      onDone={refreshIfRefused}
                      aria-label={`Deactivate ${row.displayName}`}
                      confirm={{
                        title: `Deactivate ${row.displayName}?`,
                        description:
                          "They will lose access to the staff area straight away, even if they are signed in. Their past work is kept. You can reactivate them later.",
                        confirmLabel: "Deactivate",
                        destructive: true,
                      }}
                    >
                      Deactivate
                    </ActionButton>
                  ) : (
                    <ActionButton
                      action={setStaffActiveAction.bind(null, row.userId, true)}
                      onDone={refreshIfRefused}
                      aria-label={`Reactivate ${row.displayName}`}
                      confirm={{
                        title: `Reactivate ${row.displayName}?`,
                        description: `They will be able to sign in again with the ${row.role} role.`,
                        confirmLabel: "Reactivate",
                      }}
                    >
                      Reactivate
                    </ActionButton>
                  )}
                  {block ? (
                    <p className="max-w-64 text-xs text-muted-foreground sm:text-right">
                      {BLOCK_NOTE[block]}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
