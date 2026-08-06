-- ===========================================================================
-- SkelClock 0003 — default work activities
--
-- The brief's starting list, as data rather than an enum so the office can
-- add "Scaffold inspection" later without a deploy. Travel and Yard are
-- flagged is_travel/paid appropriately because the segment builder treats
-- travel as its own segment type for costing.
-- ===========================================================================

create or replace function seed_default_activities(p_company_id uuid)
returns void language plpgsql as $$
begin
  insert into work_activity (company_id, code, name, is_travel, is_paid, sort_order)
  values
    (p_company_id, 'ERECT',    'Erect',               false, true,  10),
    (p_company_id, 'MODIFY',   'Modify',              false, true,  20),
    (p_company_id, 'DISMANTLE','Dismantle',           false, true,  30),
    (p_company_id, 'TRANSPORT','Transport',           false, true,  40),
    (p_company_id, 'LOADUNLOAD','Load or unload',     false, true,  50),
    (p_company_id, 'YARD',     'Yard',                false, true,  60),
    (p_company_id, 'TRAVEL',   'Travel',              true,  true,  70),
    (p_company_id, 'MATERIAL', 'Material collection', false, true,  80),
    (p_company_id, 'MEETING',  'Site meeting',        false, true,  90),
    (p_company_id, 'OFFICE',   'Office',              false, true, 100),
    (p_company_id, 'OTHER',    'Other',               false, true, 110)
  on conflict (company_id, code) do nothing;
end;
$$;
