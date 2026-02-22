import 'package:flutter/material.dart';
import '../../models/contact.dart';

class CompactContactTile extends StatefulWidget {
  final Contact contact;
  final bool selected;
  final VoidCallback onToggle;
  final VoidCallback onSelectOrganization;
  final VoidCallback onDeselectOrganization;

  const CompactContactTile({
    super.key,
    required this.contact,
    required this.selected,
    required this.onToggle,
    required this.onSelectOrganization,
    required this.onDeselectOrganization,
  });

  @override
  State<CompactContactTile> createState() => _CompactContactTileState();
}

class _CompactContactTileState extends State<CompactContactTile> {
  bool expanded = false;

  @override
  Widget build(BuildContext context) {
    final c = widget.contact;

    return Column(
      children: [
        InkWell(
          onTap: widget.onToggle,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                GestureDetector(
                  onTap: () => setState(() => expanded = !expanded),
                  child: const CircleAvatar(radius: 16),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: GestureDetector(
                    onTap: widget.onToggle,
                    child: Wrap(
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Text(
                          c.name,
                          style: const TextStyle(
                              fontWeight: FontWeight.w600),
                        ),
                        if (c.organization != null &&
                            c.organization!.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(left: 8),
                            child: GestureDetector(
                              onTap: widget.onSelectOrganization,
                              onLongPress: widget.onDeselectOrganization,
                              child: Text(
                                c.organization!,
                                style: const TextStyle(
                                    fontSize: 12,
                                    color: Colors.grey),
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
                if (c.hasSms)
                  const Padding(
                    padding: EdgeInsets.only(right: 6),
                    child: Icon(Icons.sms, size: 16),
                  ),
                if (c.hasEmail)
                  const Padding(
                    padding: EdgeInsets.only(right: 6),
                    child: Icon(Icons.email, size: 16),
                  ),
                Checkbox(
                  value: widget.selected,
                  onChanged: (_) => widget.onToggle(),
                ),
              ],
            ),
          ),
        ),
        if (expanded)
          Padding(
            padding: const EdgeInsets.only(left: 48, bottom: 6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (c.phone != null) Text("Phone: ${c.phone}"),
                if (c.email != null) Text("Email: ${c.email}"),
              ],
            ),
          ),
        const Divider(height: 1),
      ],
    );
  }
}