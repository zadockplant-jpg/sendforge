import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../../models/group.dart';
import '../../models/contact.dart';
import '../../services/groups_api.dart';
import '../colors.dart';
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
  bool busy = false;
  String? err;

  // snapshot selection
  final Set<String> selectedContactIds = {};

  // meta selection
  final Set<String> selectedChildGroupIds = {};

  GroupsApi get api => GroupsApi(widget.appState);

  @override
  void initState() {
    super.initState();

    if (widget.group.type == 'meta') {
      _loadMetaLinks();
    } else {
      // Seed selection from current members list
      for (final c in widget.group.members) {
        if (c.id.isNotEmpty) selectedContactIds.add(c.id);
      }
    }
  }

  Future<void> _loadMetaLinks() async {
    setState(() {
      busy = true;
      err = null;
    });

    try {
      final children = await api.getMetaLinks(widget.group.id);
      selectedChildGroupIds
        ..clear()
        ..addAll(children.map((g) => g.id));
    } catch (e) {
      err = e.toString();
    } finally {
      if (mounted) {
        setState(() => busy = false);
      }
    }
  }

  Future<void> _saveSnapshotMembers() async {
    setState(() {
      busy = true;
      err = null;
    });

    try {
      await api.updateMembers(widget.group.id, selectedContactIds.toList());
      await widget.appState.loadGroups();
      if (mounted) Navigator.pop(context);
    } catch (e) {
      setState(() => err = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _saveMetaLinks() async {
    setState(() {
      busy = true;
      err = null;
    });

    try {
      await api.updateMetaLinks(widget.group.id, selectedChildGroupIds.toList());
      await widget.appState.loadGroups();
      if (mounted) Navigator.pop(context);
    } catch (e) {
      setState(() => err = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final isMeta = widget.group.type == 'meta';

    return Scaffold(
      appBar: AppBar(
        title: Text(isMeta ? "Meta Group" : "Group"),
        backgroundColor: SFColors.primaryBlue,
        foregroundColor: Colors.white,
        actions: [
          TextButton(
            onPressed: busy ? null : (isMeta ? _saveMetaLinks : _saveSnapshotMembers),
            child: const Text(
              "Save",
              style: TextStyle(color: Colors.white, fontWeight: FontWeight.w900),
            ),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            if (err != null)
              Padding(
                padding: const EdgeInsets.all(12),
                child: Text(err!, style: const TextStyle(color: Colors.red)),
              ),

            if (busy)
              const Padding(
                padding: EdgeInsets.all(12),
                child: LinearProgressIndicator(),
              ),

            Expanded(
              child: isMeta ? _buildMetaBody() : _buildSnapshotBody(),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSnapshotBody() {
    final all = widget.appState.contacts;

    if (all.isEmpty) {
      return const Center(child: Text("No contacts yet."));
    }

    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(10, 10, 10, 14),
      itemCount: all.length,
      separatorBuilder: (_, __) => const SizedBox(height: 6),
      itemBuilder: (_, i) {
        final c = all[i];
        final sel = selectedContactIds.contains(c.id);

        return Container(
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: Colors.black.withOpacity(0.06)),
          ),
          child: CompactContactTile(
            contact: c,
            selected: sel,
            onToggleSelected: () {
              setState(() {
                if (sel) {
                  selectedContactIds.remove(c.id);
                } else {
                  selectedContactIds.add(c.id);
                }
              });
            },
          ),
        );
      },
    );
  }

  Widget _buildMetaBody() {
    // Meta group can only select existing groups (not contacts).
    // Exclude self to prevent direct self-cycle. (We still allow meta nesting.)
    final groups = widget.appState.groups.where((g) => g.id != widget.group.id).toList();

    if (groups.isEmpty) {
      return const Center(child: Text("No groups to link yet."));
    }

    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(10, 10, 10, 14),
      itemCount: groups.length,
      separatorBuilder: (_, __) => const SizedBox(height: 6),
      itemBuilder: (_, i) {
        final g = groups[i];
        final sel = selectedChildGroupIds.contains(g.id);

        return InkWell(
          onTap: () {
            setState(() {
              if (sel) {
                selectedChildGroupIds.remove(g.id);
              } else {
                selectedChildGroupIds.add(g.id);
              }
            });
          },
          borderRadius: BorderRadius.circular(14),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: Colors.black.withOpacity(0.06)),
            ),
            child: Row(
              children: [
                CircleAvatar(
                  radius: 18,
                  child: Text(
                    (g.name.isNotEmpty ? g.name.substring(0, 1) : "?").toUpperCase(),
                    style: const TextStyle(fontWeight: FontWeight.w900),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    g.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontWeight: FontWeight.w800),
                  ),
                ),
                const SizedBox(width: 10),
                Text(
                  g.type == 'meta' ? 'Meta' : 'Group',
                  style: const TextStyle(color: Colors.black54, fontWeight: FontWeight.w700, fontSize: 12),
                ),
                const SizedBox(width: 8),
                Checkbox(value: sel, onChanged: (_) {
                  setState(() {
                    if (sel) {
                      selectedChildGroupIds.remove(g.id);
                    } else {
                      selectedChildGroupIds.add(g.id);
                    }
                  });
                }),
              ],
            ),
          ),
        );
      },
    );
  }
}