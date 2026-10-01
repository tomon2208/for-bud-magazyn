# Model danych — wersja projektowa

To nie jest jeszcze finalny schema SQL. Przed implementacją Tech Lead i Database/Implementer mają go dopracować.

## Główne encje

users
- id
- name
- role
- active

materials
- id
- code
- name
- category_id
- unit
- default_supplier_id
- active

material_categories
- id
- name

suppliers
- id
- name
- active

locations
- id
- code
- name
- description
- active

stock
- material_id
- location_id
- quantity

stock_movements
- id
- type
- material_id
- location_id
- quantity
- user_id
- reference_type
- reference_id
- reason
- created_at

production_orders
- id
- name
- status
- created_at

requirements
- id
- production_order_id
- source
- imported_file_name
- created_at

requirement_items
- id
- requirement_id
- material_id
- quantity
- unit

reservations
- id
- production_order_id
- material_id
- quantity
- status

purchase contexts mogą później zostać rozbudowane o purchase_orders, ale nie są wymagane do MVP.

## Ważne

Stan nie powinien być modyfikowany „po cichu”.
Każda zmiana musi mieć ślad w stock_movements.

Jeśli tabela stock przechowuje aktualny stan dla wydajności, stock_movements pozostaje historią/audytem.
