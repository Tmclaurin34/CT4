update public.gift_catalog
set image_url = case name
  when 'Unisex T-Shirt' then 'https://images.printify.com/66d81b70295ea4f038065152'
  when 'Premium T-Shirt' then 'https://images.printify.com/66c32f6ebb0d2981ff0aa7f3'
  when 'Snapback Hat' then 'https://images.printify.com/67ee6f80b6ff6deb0b0cb322'
  when 'Dad Hat' then 'https://images.printify.com/66dae085fa4ab6851b0f1172'
  when '11oz Mug' then 'https://images.printify.com/66d05caa088c440c9a00bcf4'
  when '20oz Tumbler' then 'https://images.printify.com/67c57f33abd6baa023010d93'
  when 'Tote Bag' then 'https://images.printify.com/66cdad7e4535d849640e155b'
  when 'Drawstring Bag' then 'https://images.printify.com/66d8359f9935bc2b42015826'
  when 'Spiral Notebook' then 'https://images.printify.com/66d5c96509831031450f1aa4'
  when 'Pen + Notebook Set' then 'https://images.printify.com/6a16eb3cc42fcac5500c17a0'
  when 'Pullover Hoodie' then 'https://images.printify.com/66dedd239da894140e0af9e2'
  when 'Tank Top' then 'https://images.printify.com/66c347607850aaa91c011672'
  else image_url
end,
source = case
  when source = 'seed' then 'printify_catalog'
  else source
end,
updated_at = now()
where name in (
  'Unisex T-Shirt',
  'Premium T-Shirt',
  'Snapback Hat',
  'Dad Hat',
  '11oz Mug',
  '20oz Tumbler',
  'Tote Bag',
  'Drawstring Bag',
  'Spiral Notebook',
  'Pen + Notebook Set',
  'Pullover Hoodie',
  'Tank Top'
);
