update public.gift_catalog
set image_url = case name
  when '11oz Mug' then '/assets/gifts/11oz-mug.svg'
  when '20oz Tumbler' then '/assets/gifts/20oz-tumbler.svg'
  when 'Dad Hat' then '/assets/gifts/dad-hat.svg'
  when 'Drawstring Bag' then '/assets/gifts/drawstring-bag.svg'
  when 'Pen + Notebook Set' then '/assets/gifts/pen-notebook-set.svg'
  when 'Premium T-Shirt' then '/assets/gifts/premium-t-shirt.svg'
  when 'Pullover Hoodie' then '/assets/gifts/pullover-hoodie.svg'
  when 'Snapback Hat' then '/assets/gifts/snapback-hat.svg'
  when 'Spiral Notebook' then '/assets/gifts/spiral-notebook.svg'
  when 'Tank Top' then '/assets/gifts/tank-top.svg'
  when 'Tote Bag' then '/assets/gifts/tote-bag.svg'
  when 'Unisex T-Shirt' then '/assets/gifts/unisex-t-shirt.svg'
  else image_url
end
where name in (
  '11oz Mug',
  '20oz Tumbler',
  'Dad Hat',
  'Drawstring Bag',
  'Pen + Notebook Set',
  'Premium T-Shirt',
  'Pullover Hoodie',
  'Snapback Hat',
  'Spiral Notebook',
  'Tank Top',
  'Tote Bag',
  'Unisex T-Shirt'
);
