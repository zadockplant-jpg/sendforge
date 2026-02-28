import 'package:flutter/material.dart';
import '../../models/contact.dart';

class CompactContactTile extends StatelessWidget {
  final Contact contact;
  final bool selected;

  final VoidCallback onToggle;

  final VoidCallback? onLongPressRow;
  final VoidCallback? onAvatarTap;

  const CompactContactTile({
    super.key,
    required this.contact,
    required this.selected,
    required this.onToggle,
    this.onLongPressRow,
    this.onAvatarTap,
  });

  bool get hasSms => (contact.phone != null && contact.phone!.trim().isNotEmpty);
  bool get hasEmail => (contact.email != null && contact.email!.trim().isNotEmpty);

  String _initials(String name) {
    final parts = name.trim().split(RegExp(r"\s+")).where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return "?";
    if (parts.length == 1) return parts.first.substring(0, 1).toUpperCase();
    return (parts[0].substring(0, 1) + parts[1].substring(0, 1)).toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    final org = (contact.organization ?? "").trim();

    return InkWell(
      onTap: onToggle,
      onLongPress: onLongPressRow,
      child: Container(
        height: 56,
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        color: selected ? Colors.blue.withOpacity(0.08) : null,
        child: Row(
          children: [
            GestureDetector(
              onTap: onAvatarTap,
              child: Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: Colors.black.withOpacity(0.06),
                  borderRadius: BorderRadius.circular(10),
                ),
                alignment: Alignment.center,
                child: Text(
                  _initials(contact.name),
                  style: const TextStyle(fontWeight: FontWeight.w800),
                ),
              ),
            ),
            const SizedBox(width: 10),

            // Name + org
            Expanded(
              child: Row(
                children: [
                  Flexible(
                    flex: 3,
                    child: Text(
                      contact.name,
                      style: const TextStyle(fontWeight: FontWeight.w800),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (org.isNotEmpty) ...[
                    const SizedBox(width: 10),
                    Flexible(
                      flex: 3,
                      child: Text(
                        org,
                        textAlign: TextAlign.right,
                        style: TextStyle(
                          fontSize: 12,
                          color: Colors.blueGrey.withOpacity(0.9),
                          fontWeight: FontWeight.w600,
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                ],
              ),
            ),

            const SizedBox(width: 10),

            // chips
            if (hasSms) _chip("SMS"),
            if (hasEmail) _chip("Email"),

            const SizedBox(width: 8),

            Checkbox(
              value: selected,
              onChanged: (_) => onToggle(),
              materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
              visualDensity: const VisualDensity(horizontal: -3, vertical: -3),
            ),
          ],
        ),
      ),
    );
  }

  Widget _chip(String label) {
    return Padding(
      padding: const EdgeInsets.only(right: 6),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        decoration: BoxDecoration(
          color: Colors.black.withOpacity(0.06),
          borderRadius: BorderRadius.circular(999),
        ),
        child: Text(
          label,
          style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700),
        ),
      ),
    );
  }
}