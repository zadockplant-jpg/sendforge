import 'package:flutter/material.dart';
import '../../models/contact.dart';
import '../colors.dart';

class GroupMemberPicker extends StatefulWidget {
  final List<Contact> contacts;
  final Set<String> selectedIds;
  final ValueChanged<String> onToggle;

  const GroupMemberPicker({
    super.key,
    required this.contacts,
    required this.selectedIds,
    required this.onToggle,
  });

  @override
  State<GroupMemberPicker> createState() => _GroupMemberPickerState();
}

class _GroupMemberPickerState extends State<GroupMemberPicker> {
  String query = '';

  @override
  Widget build(BuildContext context) {
    final filtered = widget.contacts.where((c) {
      return c.name.toLowerCase().contains(query.toLowerCase());
    }).toList();

    return Column(
      children: [
        TextField(
          decoration: const InputDecoration(
            hintText: 'Search contacts',
            prefixIcon: Icon(Icons.search),
          ),
          onChanged: (v) => setState(() => query = v),
        ),
        const SizedBox(height: 8),
        Expanded(
          child: ListView.builder(
            itemCount: filtered.length,
            itemBuilder: (_, i) {
              final c = filtered[i];
              final selected = widget.selectedIds.contains(c.id);
              return ListTile(
                leading: CircleAvatar(
                  backgroundColor:
                      selected ? SFColors.primaryBlue : Colors.grey.shade300,
                  child: Text(c.name[0]),
                ),
                title: Text(c.name),
                trailing: selected ? const Icon(Icons.check) : null,
                onTap: () => widget.onToggle(c.id),
              );
            },
          ),
        ),
      ],
    );
  }
}
