import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../../models/group.dart';
import '../../models/contact.dart';
import '../../services/groups_api.dart';

class GroupDetailScreen extends StatefulWidget {
  final AppState appState;
  final Group group;

  const GroupDetailScreen({
    super.key,
    required this.appState,
    required this.group,
  });

  @override
  State<GroupDetailScreen> createState() =>
      _GroupDetailScreenState();
}

class _GroupDetailScreenState
    extends State<GroupDetailScreen> {

  final Set<String> selectedIds = {};
  final Set<String> selectedGroupIds = {};

  bool saving = false;

  @override
  void initState() {
    super.initState();

    if (widget.group.type == "snapshot") {
      selectedIds.addAll(
        widget.group.members.map((m) => m.id),
      );
    }
  }

  Future<void> _save() async {
    setState(() => saving = true);

    final api = GroupsApi(widget.appState);

    if (widget.group.type == "snapshot") {
      final updated = await api.updateMembers(
          widget.group.id, selectedIds.toList());
      widget.appState.upsertGroup(updated);
    } else {
      await api.updateMetaLinks(
          widget.group.id, selectedGroupIds.toList());
    }

    if (mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {

    return Scaffold(
      appBar: AppBar(
        title: Text(widget.group.name),
      ),
      body: Padding(
        padding: const EdgeInsets.all(12),
        child: widget.group.type == "snapshot"
            ? _buildContacts()
            : _buildMetaGroups(),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: saving ? null : _save,
        child: const Icon(Icons.save),
      ),
    );
  }

  Widget _buildMetaGroups() {
    final groups = widget.appState.groups
        .where((g) => g.id != widget.group.id)
        .toList();

    return ListView(
      children: groups.map((g) {
        final selected =
            selectedGroupIds.contains(g.id);

        return CheckboxListTile(
          title: Text(g.name),
          value: selected,
          onChanged: (v) {
            setState(() {
              if (v == true) {
                selectedGroupIds.add(g.id);
              } else {
                selectedGroupIds.remove(g.id);
              }
            });
          },
        );
      }).toList(),
    );
  }

  Widget _buildContacts() {
    final contacts = widget.appState.contacts;

    return ListView.builder(
      itemCount: contacts.length,
      itemBuilder: (context, i) {
        final c = contacts[i];
        final selected =
            selectedIds.contains(c.id);

        return InkWell(
          onTap: () {
            setState(() {
              if (selected) {
                selectedIds.remove(c.id);
              } else {
                selectedIds.add(c.id);
              }
            });
          },
          child: Padding(
            padding: const EdgeInsets.symmetric(
                vertical: 6),
            child: Row(
              children: [

                GestureDetector(
                  onTap: () {
                    showDialog(
                      context: context,
                      builder: (_) => AlertDialog(
                        title: Text(c.name),
                        content: Column(
                          mainAxisSize:
                              MainAxisSize.min,
                          crossAxisAlignment:
                              CrossAxisAlignment
                                  .start,
                          children: [
                            if (c.phone != null)
                              Text("Phone: ${c.phone}"),
                            if (c.email != null)
                              Text("Email: ${c.email}"),
                          ],
                        ),
                      ),
                    );
                  },
                  child: CircleAvatar(
                    radius: 18,
                    child: Text(
                      c.name.isNotEmpty
                          ? c.name[0]
                          : "?",
                    ),
                  ),
                ),

                const SizedBox(width: 8),

                Expanded(
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          c.name,
                          style: const TextStyle(
                              fontWeight:
                                  FontWeight.w600),
                        ),
                      ),
                      if (c.organization != null)
                        Padding(
                          padding:
                              const EdgeInsets.only(
                                  right: 8),
                          child: Text(
                            c.organization!,
                            style: const TextStyle(
                                fontSize: 12,
                                color:
                                    Colors.grey),
                          ),
                        ),
                    ],
                  ),
                ),

                if (c.hasSms)
                  _bubble("SMS"),

                if (c.hasEmail)
                  _bubble("Email"),

                Checkbox(
                  value: selected,
                  onChanged: (_) {
                    setState(() {
                      if (selected) {
                        selectedIds.remove(c.id);
                      } else {
                        selectedIds.add(c.id);
                      }
                    });
                  },
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _bubble(String text) {
    return Container(
      margin: const EdgeInsets.only(right: 6),
      padding: const EdgeInsets.symmetric(
          horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: Colors.blue.shade50,
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        text,
        style: const TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w600),
      ),
    );
  }
}