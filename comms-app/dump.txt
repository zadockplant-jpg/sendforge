#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-.}"
OUT="${2:-sendforge_dump_$(date +%Y%m%d_%H%M%S).txt}"

# Add files here as we grow
FILES=(
  "comms-app/services/backend/src/routes/blasts.quote.routes.js"
  "comms-app/services/backend/src/routes/blasts.send.routes.js"
  "comms-app/services/backend/src/routes/groups.routes.js"
  "comms-app/services/backend/src/routes/contacts.import.routes.js"
  "comms-app/services/backend/src/middleware/auth.js"
  "comms-app/services/backend/src/config/db.js"

  "comms-app/apps/mobile/lib/ui/screens/create_blast_screen.dart"
  "comms-app/apps/mobile/lib/ui/screens/groups_screen.dart"
  "comms-app/apps/mobile/lib/ui/screens/groups_list_screen.dart"
  "comms-app/apps/mobile/lib/ui/screens/group_detail_screen.dart"
  "comms-app/apps/mobile/lib/services/blasts_api.dart"
  "comms-app/apps/mobile/lib/services/groups_api.dart"
  "comms-app/apps/mobile/lib/core/app_state.dart"
  "comms-app/apps/mobile/lib/models/group.dart"
)

: > "$OUT"

for f in "${FILES[@]}"; do
  echo "==============================" >> "$OUT"
  echo "FILE: $f" >> "$OUT"
  echo "==============================" >> "$OUT"
  if [ -f "$ROOT/$f" ]; then
    cat "$ROOT/$f" >> "$OUT"
  else
    echo "FILE NOT FOUND" >> "$OUT"
  fi
  echo -e "\n" >> "$OUT"
done

echo "Wrote: $OUT"