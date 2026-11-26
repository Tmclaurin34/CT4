create policy campaign_sends_staff_read on public.campaign_sends for select using (clicktide_can_access_client(user_id));
