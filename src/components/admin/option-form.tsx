import { ActionButton } from "@/components/admin/action-button";
import { ActionForm, CheckField, SubmitButton, TextField } from "@/components/admin/action-form";
import { Badge } from "@/components/ui/badge";
import {
  deleteOptionAction,
  moveOptionAction,
  saveOptionAction,
  setOptionFlagAction,
} from "@/app/staff/(protected)/manager/menu/actions";
import { paiseToInput } from "@/lib/menu/plan";
import type { OptionRow } from "@/lib/menu/repository";
import { LIMITS } from "@/lib/menu/validation";

const PRICE_HINT = "Extra charge in rupees. 0 for free.";

export function NewOptionForm({ groupId }: { groupId: string }) {
  return (
    <ActionForm action={saveOptionAction} label="Add option" resetOnSuccess>
      <input type="hidden" name="id" value="" />
      <input type="hidden" name="groupId" value={groupId} />
      <input type="hidden" name="isActive" value="on" />
      <input type="hidden" name="isAvailable" value="on" />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="name"
          label="Option name"
          placeholder="Large"
          maxLength={LIMITS.name}
          required
        />
        <TextField
          name="price"
          label="Extra price (₹)"
          hint={PRICE_HINT}
          required
          inputMode="decimal"
          autoComplete="off"
          defaultValue="0"
        />
      </div>
      <CheckField name="isDefault" label="Pre-selected for customers" />
      <div>
        <SubmitButton>Add option</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function OptionEditor({
  option,
  first,
  last,
}: {
  option: OptionRow;
  first: boolean;
  last: boolean;
}) {
  return (
    <li className="flex flex-col gap-4 py-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold">{option.name}</h3>
        {!option.is_active ? <Badge variant="outline">Archived</Badge> : null}
        {option.is_active && !option.is_available ? (
          <Badge variant="statusCancelled">Sold out</Badge>
        ) : null}
        {option.is_default ? <Badge variant="secondary">Default</Badge> : null}
      </div>
      <ActionForm action={saveOptionAction} label={`Edit option ${option.name}`}>
        <input type="hidden" name="id" value={option.id} />
        <input type="hidden" name="groupId" value={option.group_id} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            name="name"
            label="Option name"
            defaultValue={option.name}
            maxLength={LIMITS.name}
            required
          />
          <TextField
            name="price"
            label="Extra price (₹)"
            hint={PRICE_HINT}
            required
            inputMode="decimal"
            autoComplete="off"
            defaultValue={paiseToInput(option.price_delta_paise)}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <CheckField name="isDefault" label="Pre-selected" defaultChecked={option.is_default} />
          <CheckField name="isActive" label="Show to customers" defaultChecked={option.is_active} />
          <CheckField
            name="isAvailable"
            label="Available today"
            defaultChecked={option.is_available}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <SubmitButton size="sm" variant="secondary" aria-label={`Save option ${option.name}`}>
            Save
          </SubmitButton>
          <ActionButton
            action={moveOptionAction.bind(null, option.id, "up")}
            disabled={first}
            aria-label={`Move ${option.name} up`}
          >
            Up
          </ActionButton>
          <ActionButton
            action={moveOptionAction.bind(null, option.id, "down")}
            disabled={last}
            aria-label={`Move ${option.name} down`}
          >
            Down
          </ActionButton>
          <ActionButton
            action={setOptionFlagAction.bind(null, option.id, "is_available", !option.is_available)}
            aria-label={`${option.is_available ? "Mark sold out" : "Mark available"}: ${option.name}`}
          >
            {option.is_available ? "Mark sold out" : "Mark available"}
          </ActionButton>
          <ActionButton
            variant="ghost"
            action={deleteOptionAction.bind(null, option.id)}
            aria-label={`Delete option ${option.name}`}
            confirm={{
              title: `Delete "${option.name}"?`,
              description:
                "This permanently removes the option. If a past order used it, archive it instead.",
              confirmLabel: "Delete",
              destructive: true,
            }}
          >
            Delete
          </ActionButton>
        </div>
      </ActionForm>
    </li>
  );
}
