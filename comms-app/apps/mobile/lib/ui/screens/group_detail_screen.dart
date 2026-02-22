import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../../models/group.dart';
import '../../models/contact.dart';
import '../../services/groups_api.dart';
import '../components/compact_contact_tile.dart';

class GroupDetailScreen extends StatefulWidget {
  final AppState appState;
  final Group group;

  const GroupDetailScreen({
    super.key,
    required this.appState,
    required this.group,
  });

  @override
  State<GroupDetailScreen> createState() => _GroupDetailScreenState();
}

class _GroupDetailScreenState extends State<GroupDetailScreen> {
  late Set<String> _selectedMemberIds;
  final TextEditingController _search = TextEditingController();
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _selectedMemberIds =
        widget.group.members.map((m) => m.id).toSet();
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    final api = GroupsApi(widget.appState);
    await api.updateMembers(
      widget.group.id,
      _selectedMemberIds.toList(),
    );
    if (!mounted) return;
    Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final allContacts = widget.appState.contacts;
    final query = _search.text.toLowerCase();

    final contacts = allContacts.where((c) {
      return c.name.toLowerCase().contains(query) ||
          (c.organization ?? '')
              .toLowerCase()
              .contains(query);
    }).toList();

    contacts.sort((a, b) =>
        a.name.toLowerCase().compareTo(b.name.toLowerCase()));

    return Scaffold(
      appBar: AppBar(
        title: Text(widget.group.name),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _search,
                    decoration: const InputDecoration(
                      hintText: "Search contacts...",
                      isDense: true,
                      border: OutlineInputBorder(),
                    ),
                    onChanged: (_) => setState(() {}),
                  ),
                ),
                const SizedBox(width: 8),
                ElevatedButton(
                  onPressed: _saving ? null : _save,
                  child: _saving
                      ? const SizedBox(
                          width: 14,
                          height: 14,
                          child: CircularProgressIndicator(
                              strokeWidth: 2))
                      : const Text("Save"),
                )
              ],
            ),
          ),
          Expanded(
            child: ListView.builder(
              itemCount: contacts.length,
              itemBuilder: (context, i) {
                final c = contacts[i];
                final selected =
                    _selectedMemberIds.contains(c.id);

                return CompactContactTile(
                  contact: c,
                  selected: selected,
                  onToggle: () {
                    setState(() {
                      selected
                          ? _selectedMemberIds.remove(c.id)
                          : _selectedMemberIds.add(c.id);
                    });
                  },
                  onSelectOrganization: () {
                    final org = c.organization;
                    if (org == null) return;
                    final orgContacts = allContacts
                        .where((x) =>
                            x.organization == org)
                        .map((x) => x.id);
                    setState(() {
                      _selectedMemberIds.addAll(orgContacts);
                    });
                  },
                  onDeselectOrganization: () {
                    final org = c.organization;
                    if (org == null) return;
                    final orgContacts = allContacts
                        .where((x) =>
                            x.organization == org)
                        .map((x) => x.id);
                    setState(() {
                      _selectedMemberIds
                          .removeAll(orgContacts);
                    });
                  },
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}