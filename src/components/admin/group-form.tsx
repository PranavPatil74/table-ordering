import { ActionForm, CheckField, SubmitButton, TextField } from "@/components/admin/action-form";
import { saveGroupAction } from "@/app/staff/(protected)/manager/menu/actions";
import type { GroupRow } from "@/lib/menu/repository";
import { LIMITS } from "@/lib/menu/validation";

/** Create / edit form for a modifier group (name and how many choices a customer must/may make). */
export function GroupForm({ group }: { group?: GroupRow }) {
  return (
    <ActionForm
      action={saveGroupAction}
      label={group ? `Edit ${group.name}` : "Add modifier group"}
      resetOnSuccess={!group}
    >
      <input type="hidden" name="id" value={group?.id ?? ""} />
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          name="name"
          label="Name"
          placeholder="Size"
          defaultValue={group?.name}
          maxLength={LIMITS.name}
          required
        />
        <TextField
          name="minSelect"
          label="Minimum choices"
          hint="0 = optional. 1 = customer must pick."
          required
          inputMode="numeric"
          defaultValue={String(group?.min_select ?? 0)}
        />
        <TextField
          name="maxSelect"
          label="Maximum choices"
          hint="1 = pick one. More = pick several."
          required
          inputMode="numeric"
          defaultValue={String(group?.max_select ?? 1)}
        />
      </div>
      {group ? (
        <CheckField name="isActive" label="Show to customers" defaultChecked={group.is_active} />
      ) : (
        <input type="hidden" name="isActive" value="on" />
      )}
      <div>
        <SubmitButton>{group ? "Save group" : "Add group"}</SubmitButton>
      </div>
    </ActionForm>
  );
}
