// apps/mobile/lib/ui/screens/groups_list_screen.dart
import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../../models/group.dart';
import '../../services/groups_api.dart';
import '../colors.dart';
import '../groups/group_avatar_atlas.dart';
import 'group_detail_screen.dart';

class GroupsListScreen extends StatefulWidget {
  final AppState appState;
  final bool embedMode;
  final Future<void> Function()? onRefresh;

  const GroupsListScreen({
    super.key,
    required this.appState,
    this.embedMode = false,
    this.onRefresh,
  });

  @override
  State<GroupsListScreen> createState() => _GroupsListScreenState();
}

class _GroupsListScreenState extends State<GroupsListScreen> {
  bool busy = true;
  List<Group> groups = [];
  String? error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      busy = true;
      error = null;
    });

    try {
      final api = GroupsApi(widget.appState);
      final data = await api.list();

      widget.appState.groups
        ..clear()
        ..addAll(data);

      if (!mounted) return;
      setState(() {
        groups = data;
        busy = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        error = e.toString();
        busy = false;
      });
    }
  }

  Widget _buildLeading(Group g) {
    if (g.avatarKey != null && g.avatarKey!.isNotEmpty) {
      return GroupAvatarAtlas(
        avatarKey: g.avatarKey!,
        size: 44,
      );
    }

    return Container(
      width: 44,
      height: 44,
      decoration: BoxDecoration(
        color: Colors.black.withOpacity(0.05),
        borderRadius: BorderRadius.circular(12),
      ),
      child: const Icon(Icons.group_outlined),
    );
  }

  Widget _content() {
    if (busy) return const Center(child: CircularProgressIndicator());
    if (error != null) {
      return Center(
        child: Text(error!, style: const TextStyle(color: Colors.red)),
      );
    }
    if (groups.isEmpty) return const Center(child: Text("No groups yet."));

    return RefreshIndicator(
      onRefresh: () async {
        await _load();
        if (widget.onRefresh != null) await widget.onRefresh!();
      },
      child: ListView.separated(
        itemCount: groups.length,
        separatorBuilder: (_, __) => const SizedBox(height: 8),
        itemBuilder: (context, i) {
          final g = groups[i];
          final subtitle = g.type == "meta"
              ? '${g.memberCount} members (dynamic)'
              : '${g.memberCount} members';

          return InkWell(
            borderRadius: BorderRadius.circular(12),
            onTap: () async {
              await Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (_) => GroupDetailScreen(
                    appState: widget.appState,
                    group: g,
                  ),
                ),
              );

              await _load();
            },
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: SFColors.cardBorder),
              ),
              child: Row(
                children: [
                  _buildLeading(g),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          g.name,
                          style: const TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w800,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 3),
                        Text(
                          subtitle,
                          style: const TextStyle(
                            fontSize: 13,
                            color: SFColors.textMuted,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  const Icon(Icons.chevron_right),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (widget.embedMode) return _content();

    return Scaffold(
      appBar: AppBar(title: const Text('Groups')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: _content(),
      ),
    );
  }
}