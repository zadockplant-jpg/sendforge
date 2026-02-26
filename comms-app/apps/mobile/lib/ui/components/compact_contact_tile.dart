import 'package:flutter/material.dart';
import '../../models/contact.dart';

class CompactContactTile extends StatelessWidget {
  final Contact contact;
  final bool selected;
  final VoidCallback onToggleSelected;

  const CompactContactTile({
    super.key,
    required this.contact,
    required this.selected,
    required this.onToggleSelected,
  });

  String _initials(String name) {
    final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return '?';
    if (parts.length == 1) return parts.first.substring(0, 1).toUpperCase();
    return (parts[0].substring(0, 1) + parts[1].substring(0, 1)).toUpperCase();
  }

  void _showContactModal(BuildContext context) {
    showModalBottomSheet(
      context: context,
      showDragHandle: true,
      builder: (_) {
        return Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  CircleAvatar(
                    radius: 22,
                    child: Text(_initials(contact.name)),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(contact.name, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                        const SizedBox(height: 2),
                        if ((contact.organization ?? '').trim().isNotEmpty)
                          Text(contact.organization!, style: const TextStyle(color: Colors.black54)),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              if ((contact.phone ?? '').trim().isNotEmpty)
                _InfoRow(label: "Phone", value: contact.phone!),
              if ((contact.email ?? '').trim().isNotEmpty)
                _InfoRow(label: "Email", value: contact.email!),
              const SizedBox(height: 6),
            ],
          ),
        );
      },
    );
  }

  Widget _chip(String text) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: Colors.black.withOpacity(0.06),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(text, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final hasSms = (contact.phone ?? '').trim().isNotEmpty;
    final hasEmail = (contact.email ?? '').trim().isNotEmpty;
    final org = (contact.organization ?? '').trim();

    return InkWell(
      onTap: onToggleSelected,
      borderRadius: BorderRadius.circular(14),
      child: Padding(
        // tighter: ~50% shrink vs roomy tiles
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        child: Row(
          children: [
            GestureDetector(
              onTap: () => _showContactModal(context),
              child: CircleAvatar(
                radius: 18,
                child: Text(_initials(contact.name), style: const TextStyle(fontWeight: FontWeight.w800)),
              ),
            ),
            const SizedBox(width: 10),

            Expanded(
              child: Row(
                children: [
                  // Name left
                  Expanded(
                    child: Text(
                      contact.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 14),
                    ),
                  ),

                  // Org tight on right
                  if (org.isNotEmpty) ...[
                    const SizedBox(width: 10),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 150),
                      child: Text(
                        org,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        textAlign: TextAlign.right,
                        style: const TextStyle(fontSize: 12, color: Colors.black54, fontWeight: FontWeight.w600),
                      ),
                    ),
                  ],
                ],
              ),
            ),

            const SizedBox(width: 10),

            // Chips LEFT of checkbox
            if (hasSms) _chip("SMS"),
            if (hasSms && hasEmail) const SizedBox(width: 6),
            if (hasEmail) _chip("Email"),

            const SizedBox(width: 10),

            Checkbox(
              value: selected,
              onChanged: (_) => onToggleSelected(),
            ),
          ],
        ),
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  final String label;
  final String value;
  const _InfoRow({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        children: [
          SizedBox(width: 70, child: Text(label, style: const TextStyle(color: Colors.black54))),
          Expanded(child: Text(value, style: const TextStyle(fontWeight: FontWeight.w700))),
        ],
      ),
    );
  }
}