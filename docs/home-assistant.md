# Home Assistant

SVault can feed a Home Assistant dashboard or automation through a small read-only summary endpoint.
One REST sensor polls the endpoint every five minutes and exposes the household counters as ordinary
Home Assistant sensors: item count, low stock, expiring and expired lots, open shopping-list lines and
unread reminders.

The endpoint is `GET /api/houses/:houseId/summary`. It returns one compact object:

```json
{
  "houseId": "hse_xxx",
  "houseName": "Alex's Home",
  "itemCount": 42,
  "lowStockCount": 3,
  "expiringSoonCount": 2,
  "expiredCount": 1,
  "shoppingListOpenCount": 7,
  "unreadReminders": 4,
  "updatedAt": "2026-11-14T09:30:00.000Z"
}
```

See the [API reference](api.md#house-summary) for what each field counts. The endpoint works with a
read-only API token as well as a signed-in session cookie.

## 1. Create a read-only token

1. Sign in to SVault and open **Profile → API tokens**.
2. Type a name such as `Home Assistant` under **New token name** and select **Create**. Copy the value
   that appears; it starts with `svt_` and is displayed only once.
3. Store it in Home Assistant's `secrets.yaml`, not in `configuration.yaml`:

```yaml
# secrets.yaml
svault_token: "Bearer svt_paste_the_token_here"
```

The `Bearer ` prefix is part of the stored value because Home Assistant does not template REST
headers. The token can only read data for houses the creating user belongs to; it cannot change
anything, and it stops working if the user leaves the house or the token is revoked.

## 2. Find the house ID

Open the house in SVault and read the ID from the browser address bar (it looks like `hse_...`), or
list your houses with the token:

```bash
curl -H "Authorization: Bearer svt_..." https://svault.example.com/api/houses
```

Use the `id` of the house you want to expose in the configuration below.

## 3. Add the REST sensor

Home Assistant's `rest` integration makes **one request per `scan_interval`** for the whole block and
turns each `value_template` into a separate sensor. Add this to `configuration.yaml` (or a package
file) and replace the resource URL and house ID:

```yaml
rest:
  - resource: "https://svault.example.com/api/houses/hse_xxxxxxxx/summary"
    scan_interval: 300
    verify_ssl: true
    headers:
      Authorization: !secret svault_token
      Accept: "application/json"
    sensor:
      - name: "SVault items"
        unique_id: svault_items
        value_template: "{{ value_json.itemCount }}"
        unit_of_measurement: "items"
        state_class: measurement
      - name: "SVault low stock"
        unique_id: svault_low_stock
        value_template: "{{ value_json.lowStockCount }}"
        unit_of_measurement: "items"
        state_class: measurement
      - name: "SVault expiring soon"
        unique_id: svault_expiring_soon
        value_template: "{{ value_json.expiringSoonCount }}"
        unit_of_measurement: "items"
        state_class: measurement
      - name: "SVault expired"
        unique_id: svault_expired
        value_template: "{{ value_json.expiredCount }}"
        unit_of_measurement: "items"
        state_class: measurement
      - name: "SVault shopping list"
        unique_id: svault_shopping_list
        value_template: "{{ value_json.shoppingListOpenCount }}"
        unit_of_measurement: "lines"
        state_class: measurement
      - name: "SVault unread reminders"
        unique_id: svault_unread_reminders
        value_template: "{{ value_json.unreadReminders }}"
        unit_of_measurement: "reminders"
        state_class: measurement
      - name: "SVault last update"
        unique_id: svault_last_update
        value_template: "{{ value_json.updatedAt }}"
        device_class: timestamp
        json_attributes:
          - houseId
          - houseName
          - updatedAt
```

Notes:

- Keep `scan_interval: 300` (five minutes) or slower. The summary is cheap, but a household inventory
  does not change every minute, and the same advice applies to any self-hosted service behind a
  reverse proxy.
- `sensor.svault_low_stock` and the other entity IDs are derived from the `name`; adjust the
  automation below if you rename them.
- `json_attributes` puts `houseId`, `houseName` and the raw `updatedAt` on the last-update sensor, which
  is handy for a template card showing which house the numbers belong to.
- Reload the REST integration (or restart Home Assistant) after editing the YAML. **Developer tools →
  States** shows the new sensors and their last poll.

## 4. Notify when stock is low

This automation fires when the low-stock count rises above zero and stays there for ten minutes
(so a brief blip during a shopping session does not notify). Change `notify.notify` to your own
notifier, for example `notify.mobile_app_alex`.

```yaml
automation:
  - alias: "SVault low stock"
    id: svault_low_stock_notify
    trigger:
      - platform: numeric_state
        entity_id: sensor.svault_low_stock
        above: 0
        for: "00:10:00"
    action:
      - service: notify.notify
        data:
          title: "SVault: low stock"
          message: >-
            {{ states('sensor.svault_low_stock') }} item(s) in
            {{ state_attr('sensor.svault_last_update', 'houseName') }} are at or below
            their reorder point. Open the shopping list:
            https://svault.example.com/shopping
```

A `numeric_state` trigger fires on the transition from `0` to a positive value, not on every poll. If
you want a daily reminder while stock stays low, add a second `time` trigger at, say, 09:00 and a
`numeric_state` condition instead:

```yaml
    trigger:
      - platform: time
        at: "09:00:00"
    condition:
      - condition: numeric_state
        entity_id: sensor.svault_low_stock
        above: 0
```

## Use HTTPS and keep the token secret

- Serve SVault over HTTPS before exposing it to Home Assistant, even on the same LAN: the bearer token
  travels in a plain header and is only as private as the connection. A reverse proxy that terminates
  TLS is described in [Deployment](deployment.md#https-and-reverse-proxies). If Home Assistant uses a
  self-signed certificate, import the CA rather than setting `verify_ssl: false`.
- Keep the token in `secrets.yaml` and out of version control. The token is already read-only; if it
  is ever exposed, revoke it under **Profile → API tokens** and create a new one.
- Prefer a dedicated SVault account with `viewer` access to only the houses Home Assistant should see,
  so the token cannot read other houses on the instance.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Sensor shows `unknown` or `unavailable` | The resource URL is wrong, the token is expired/revoked, or Home Assistant cannot reach the host over HTTPS. Check the REST integration log and try the `curl` command above. |
| `401 Unauthorized` | The token is missing, revoked, or the `Authorization` secret lacks the `Bearer ` prefix. |
| `404 Not found` | The house ID is wrong, or the token's user is not a member of that house. |
| Numbers never change | Home Assistant polls every 300 seconds; wait for the next cycle and confirm `updatedAt` advances after a change in SVault. |
