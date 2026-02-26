// comms-app/apps/mobile/lib/ui/components/compact_contact_tile.dart
import 'package:flutter/material.dart';
import '../../models/contact.dart';

class CompactContactTile extends StatelessWidget {
  final Contact contact;
  final bool selected;

  final VoidCallback onToggle;
  final VoidCallback? onLongPressRow;

  final VoidCallback? onSelectOrganization;
  final VoidCallback? onDeselectOrganization;

  const CompactContactTile({
    super.key,
    required this.contact,
    required this.selected,
    required this.onToggle,
    this.onLongPressRow,
    this.onSelectOrganization,
    this.onDeselectOrganization,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onToggle,
      onLongPress: onLongPressRow,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        color: selected ? Colors.blue.withOpacity(0.08) : null,
        child: Row(
          children: [
            Checkbox(
              value: selected,
              onChanged: (_) => onToggle(),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    contact.name,
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                  if (contact.organization != null &&
                      contact.organization!.isNotEmpty)
                    GestureDetector(
                      onTap: onSelectOrganization,
                      onLongPress: onDeselectOrganization,
                      child: Text(
                        contact.organization!,
                        style: const TextStyle(
                          fontSize: 12,
                          color: Colors.blueGrey,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}