-- =========================================================================================
-- Sandwich Express: SAMPLE seed data for local development and demos
-- =========================================================================================
--
--  * Idempotent. Every row is keyed by a stable slug / code and inserted with
--    ON CONFLICT DO NOTHING, so running this file again changes nothing, and it will never
--    overwrite a price, name or availability that a manager has edited since.
--  * All prices are SAMPLE values in integer paise (14900 = Rs 149.00). The cafe owner sets the
--    real ones in the manager menu admin. Prices are authoritative on the server.
--  * Contains NO credentials, NO staff accounts and NO customer data. Staff are created through
--    Supabase Auth (see docs/database.md). Images are left empty (image_path is null).
--  * Do not run against production unless you want the sample menu there. Production should
--    be configured by the manager instead.
--
-- Apply with:  supabase db reset            (local, runs migrations then this file)
--         or:  psql "$DATABASE_URL" -f supabase/seed.sql
-- =========================================================================================

begin;

-- Categories -------------------------------------------------------------------------------
insert into public.menu_categories (slug, name, description, sort_order)
values
  ('classic-sandwiches',   'Classic Sandwiches',   'Toasted, stuffed and made to order.', 10),
  ('signature-sandwiches', 'Signature Sandwiches', 'Our house specials, with bolder fillings.', 20),
  ('sides',                'Sides',                'Something to share, or not.', 30),
  ('drinks',               'Drinks',               'Hot and cold.', 40),
  ('extras',               'Extras',               'Add a little more to your order.', 50)
on conflict (slug) do nothing;

-- Items ------------------------------------------------------------------------------------
-- (category slug, item slug, name, description, ingredients, dietary tags, sample price paise,
--  sort order, available now?)
insert into public.menu_items
  (category_id, slug, name, description, ingredients, dietary_tags, price_paise, sort_order, is_available)
select c.id, v.slug, v.name, v.description, v.ingredients, v.tags, v.price_paise, v.sort_order, v.is_available
from (
  values
    -- Classic Sandwiches
    ('classic-sandwiches', 'veg-grilled-sandwich', 'Veg Grilled Sandwich',
      'Fresh vegetables and green chutney, grilled until golden.',
      'Tomato, cucumber, capsicum, onion, green chutney, butter',
      array['veg','contains-dairy','contains-gluten'], 12900, 10, true),
    ('classic-sandwiches', 'cheese-corn-sandwich', 'Cheese Corn Sandwich',
      'Sweet corn folded into a creamy cheese filling.',
      'Sweet corn, cheese, capsicum, mayonnaise, butter',
      array['veg','contains-dairy','contains-gluten'], 14900, 20, true),
    ('classic-sandwiches', 'aloo-masala-sandwich', 'Aloo Masala Sandwich',
      'Spiced potato filling with a mint chutney kick.',
      'Potato, onion, green chilli, coriander, mint chutney, butter',
      array['veg','spicy','contains-dairy','contains-gluten'], 11900, 30, true),

    -- Signature Sandwiches
    ('signature-sandwiches', 'peri-peri-paneer-sandwich', 'Peri-Peri Paneer Sandwich',
      'Peri-peri marinated paneer with crunchy onions and a tangy sauce.',
      'Paneer, peri-peri marinade, onion, capsicum, mayonnaise',
      array['veg','spicy','contains-dairy','contains-gluten'], 17900, 10, true),
    ('signature-sandwiches', 'paneer-tikka-melt', 'Paneer Tikka Melt',
      'Tandoori paneer with melted cheese.',
      'Paneer tikka, cheese, onion, mint mayonnaise',
      array['veg','spicy','contains-dairy','contains-gluten'], 18900, 20, true),
    ('signature-sandwiches', 'mediterranean-veggie-sandwich', 'Mediterranean Veggie Sandwich',
      'Grilled vegetables, olives and herbed hummus.',
      'Zucchini, bell pepper, olives, hummus, lettuce',
      array['veg','contains-gluten'], 17900, 30, true),
    ('signature-sandwiches', 'chicken-tikka-sandwich', 'Chicken Tikka Sandwich',
      'Smoky chicken tikka with mint mayo.',
      'Chicken tikka, onion, lettuce, mint mayonnaise',
      array['non-veg','spicy','contains-gluten'], 19900, 40, true),

    -- Sides
    ('sides', 'french-fries', 'French Fries',
      'Crisp, hot and salted.',
      'Potato, oil, salt',
      array['veg','vegan'], 9900, 10, true),
    ('sides', 'peri-peri-fries', 'Peri-Peri Fries',
      'French fries tossed in peri-peri seasoning.',
      'Potato, oil, peri-peri seasoning',
      array['veg','vegan','spicy'], 11900, 20, true),
    -- Sample of a "sold out" item: visible on the menu but cannot be ordered.
    ('sides', 'garlic-bread', 'Garlic Bread',
      'Toasted bread with garlic butter.',
      'Bread, butter, garlic, parsley',
      array['veg','contains-dairy','contains-gluten'], 10900, 30, false),

    -- Drinks
    ('drinks', 'cold-coffee', 'Cold Coffee',
      'Chilled, creamy and lightly sweet.',
      'Coffee, milk, sugar, ice',
      array['veg','contains-dairy'], 11900, 10, true),
    ('drinks', 'masala-chai', 'Masala Chai',
      'Hot tea simmered with spices.',
      'Tea, milk, sugar, ginger, cardamom',
      array['veg','contains-dairy'], 6900, 20, true),
    ('drinks', 'fresh-lime-soda', 'Fresh Lime Soda',
      'Fresh lime and soda, sweet or salted.',
      'Lime, soda, sugar, salt',
      array['veg','vegan'], 7900, 30, true),

    -- Extras
    ('extras', 'extra-cheese-slice', 'Extra Cheese Slice',
      'One more slice of cheese.',
      'Cheese',
      array['veg','contains-dairy'], 3000, 10, true),
    ('extras', 'mint-mayo-dip', 'Mint Mayo Dip',
      'A cool mint mayonnaise dip.',
      'Mayonnaise, mint',
      array['veg','contains-dairy'], 2000, 20, true),
    ('extras', 'peri-peri-dip', 'Peri-Peri Dip',
      'A hot peri-peri dip.',
      'Peri-peri sauce, mayonnaise',
      array['veg','spicy','contains-dairy'], 2000, 30, true)
) as v (category_slug, slug, name, description, ingredients, tags, price_paise, sort_order, is_available)
join public.menu_categories c on c.slug = v.category_slug
on conflict (slug) do nothing;

-- Modifier groups --------------------------------------------------------------------------
-- min_select >= 1 makes a group required; max_select = 1 makes it single choice.
insert into public.modifier_groups (slug, name, min_select, max_select, sort_order)
values
  ('bread',            'Bread',            1, 1, 10),
  ('spice-level',      'Spice level',      1, 1, 20),
  ('sauces',           'Sauces',           0, 2, 30),
  ('extras',           'Add extras',       0, 3, 40),
  ('fries-seasoning',  'Seasoning',        1, 1, 50),
  ('drink-size',       'Size',             1, 1, 60)
on conflict (slug) do nothing;

-- Modifier options (sample extra price per unit, in integer paise) -------------------------
insert into public.modifier_options (group_id, name, price_delta_paise, is_default, sort_order)
select g.id, v.name, v.price_delta_paise, v.is_default, v.sort_order
from (
  values
    ('bread', 'White bread',       0,    true,  10),
    ('bread', 'Brown bread',       0,    false, 20),
    ('bread', 'Multigrain bread',  1000, false, 30),

    ('spice-level', 'Mild',   0, true,  10),
    ('spice-level', 'Medium', 0, false, 20),
    ('spice-level', 'Hot',    0, false, 30),

    ('sauces', 'Mint chutney',    0,    false, 10),
    ('sauces', 'Tomato ketchup',  0,    false, 20),
    ('sauces', 'Chipotle mayo',   1000, false, 30),
    ('sauces', 'Peri-peri sauce', 1000, false, 40),

    ('extras', 'Extra cheese',  3000, false, 10),
    ('extras', 'Grilled onion', 1500, false, 20),
    ('extras', 'Jalapenos',     1500, false, 30),
    ('extras', 'Sweet corn',    2000, false, 40),

    ('fries-seasoning', 'Classic salted',  0,    true,  10),
    ('fries-seasoning', 'Peri-peri masala', 0,   false, 20),
    ('fries-seasoning', 'Cheese powder',   1500, false, 30),

    ('drink-size', 'Regular', 0,    true,  10),
    ('drink-size', 'Large',   3000, false, 20)
) as v (group_slug, name, price_delta_paise, is_default, sort_order)
join public.modifier_groups g on g.slug = v.group_slug
on conflict (group_id, lower(name)) do nothing;

-- Which groups apply to which items --------------------------------------------------------
insert into public.menu_item_modifier_groups (item_id, group_id, sort_order)
select i.id, g.id, v.sort_order
from (
  values
    ('veg-grilled-sandwich',          'bread', 10), ('veg-grilled-sandwich',          'sauces', 20), ('veg-grilled-sandwich',          'extras', 30),
    ('cheese-corn-sandwich',          'bread', 10), ('cheese-corn-sandwich',          'sauces', 20), ('cheese-corn-sandwich',          'extras', 30),
    ('aloo-masala-sandwich',          'bread', 10), ('aloo-masala-sandwich',          'spice-level', 20), ('aloo-masala-sandwich', 'sauces', 30), ('aloo-masala-sandwich', 'extras', 40),
    ('peri-peri-paneer-sandwich',     'bread', 10), ('peri-peri-paneer-sandwich',     'spice-level', 20), ('peri-peri-paneer-sandwich', 'sauces', 30), ('peri-peri-paneer-sandwich', 'extras', 40),
    ('paneer-tikka-melt',             'bread', 10), ('paneer-tikka-melt',             'spice-level', 20), ('paneer-tikka-melt', 'sauces', 30), ('paneer-tikka-melt', 'extras', 40),
    ('mediterranean-veggie-sandwich', 'bread', 10), ('mediterranean-veggie-sandwich', 'sauces', 20), ('mediterranean-veggie-sandwich', 'extras', 30),
    ('chicken-tikka-sandwich',        'bread', 10), ('chicken-tikka-sandwich',        'spice-level', 20), ('chicken-tikka-sandwich', 'sauces', 30), ('chicken-tikka-sandwich', 'extras', 40),
    ('french-fries',                  'fries-seasoning', 10), ('french-fries', 'sauces', 20),
    ('garlic-bread',                  'extras', 10),
    ('cold-coffee',                   'drink-size', 10),
    ('fresh-lime-soda',               'drink-size', 10)
) as v (item_slug, group_slug, sort_order)
join public.menu_items i on i.slug = v.item_slug
join public.modifier_groups g on g.slug = v.group_slug
on conflict (item_id, group_id) do nothing;

-- Tables T01 to T05 ------------------------------------------------------------------------
-- `code` is the identifier a table's QR code will carry. The exact QR URL shape is decided
-- when the QR generator is built (Phase 3); it is not fixed by this file.
insert into public.cafe_tables (code, label, sort_order)
values
  ('T01', 'Table 1', 10),
  ('T02', 'Table 2', 20),
  ('T03', 'Table 3', 30),
  ('T04', 'Table 4', 40),
  ('T05', 'Table 5', 50)
on conflict (code) do nothing;

commit;
