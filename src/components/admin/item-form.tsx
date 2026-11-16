import {
  ActionForm,
  CheckField,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
} from "@/components/admin/action-form";
import { saveItemAction } from "@/app/staff/(protected)/manager/menu/actions";
import { paiseToInput } from "@/lib/menu/plan";
import type { CategoryRow, ItemRow } from "@/lib/menu/repository";
import { DIETARY_TAGS, DIETARY_TAG_LABELS, LIMITS } from "@/lib/menu/validation";

/** Create / edit form for one menu item. Prices are typed in rupees and stored as integer paise. */
export function ItemForm({ item, categories }: { item?: ItemRow; categories: CategoryRow[] }) {
  const tags = new Set(item?.dietary_tags ?? []);
  return (
    <ActionForm action={saveItemAction} label={item ? `Edit ${item.name}` : "Add item"}>
      <input type="hidden" name="id" value={item?.id ?? ""} />
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          name="name"
          label="Name"
          defaultValue={item?.name}
          maxLength={LIMITS.name}
          required
        />
        <SelectField
          name="categoryId"
          label="Category"
          required
          defaultValue={item?.category_id ?? categories.find((c) => c.is_active)?.id ?? ""}
          options={categories.map((category) => ({
            value: category.id,
            label: `${category.name}${category.is_active ? "" : " (archived)"}`,
          }))}
        />
        <TextField
          name="price"
          label="Price (₹)"
          hint="In rupees, up to two decimals. For example 249 or 249.50."
          required
          inputMode="decimal"
          autoComplete="off"
          defaultValue={item ? paiseToInput(item.price_paise) : ""}
          placeholder="249.00"
        />
      </div>
      <TextAreaField
        name="description"
        label="Description (optional)"
        hint="Shown under the name on the customer menu."
        defaultValue={item?.description ?? ""}
        maxLength={LIMITS.text}
        rows={3}
      />
      <TextAreaField
        name="ingredients"
        label="Ingredients (optional)"
        hint="Helps guests with allergies."
        defaultValue={item?.ingredients ?? ""}
        maxLength={LIMITS.text}
        rows={2}
      />
      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-semibold">Dietary tags</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {DIETARY_TAGS.map((tag) => (
            <CheckField
              key={tag}
              name="dietaryTags"
              value={tag}
              label={DIETARY_TAG_LABELS[tag]}
              defaultChecked={tags.has(tag)}
            />
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <CheckField
          name="isActive"
          label="Show on the menu"
          hint="Untick to archive it: customers stop seeing it."
          defaultChecked={item?.is_active ?? true}
        />
        <CheckField
          name="isAvailable"
          label="Available today"
          hint="Untick when you have run out."
          defaultChecked={item?.is_available ?? true}
        />
      </div>
      <div>
        <SubmitButton>{item ? "Save changes" : "Add item"}</SubmitButton>
      </div>
    </ActionForm>
  );
}
