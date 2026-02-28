// comms-app/apps/mobile/lib/ui/screens/group_detail_screen.dart
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/app_state.dart';
import '../../models/group.dart';
import '../../models/contact.dart';
import '../../services/groups_api.dart';
import '../components/compact_contact_tile.dart';
import '../colors.dart';
import '../groups/group_avatar_atlas.dart';

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
  // SNAPSHOT selection state
  late Set<String> _selectedMemberIds;

  // META linking state
  Set<String> _selectedChildGroupIds = {};
  bool _metaLoaded = false;

  final TextEditingController _search = TextEditingController();
  bool _saving = false;

  // Desktop shift select
  int? _lastTappedIndex;
  bool _shiftDown = false;
  final FocusNode _keyboardFocus = FocusNode();

  // Mobile long-hold + slide select
  bool _mobileDragMode = false;
  int? _mobileDragAnchorIndex;
  int? _mobileDragLastIndex;
  double _scrollOffset = 0;

  static const double _rowHeight = 56.0;

  @override
  void initState() {
    super.initState();
    _selectedMemberIds = widget.group.members.map((m) => m.id).toSet();

    if (_isMeta) {
      _loadMetaLinks();
    } else {
      _metaLoaded = true;
    }
  }

  bool get _isMeta => (widget.group.type == "meta");

  @override
  void dispose() {
    _search.dispose();
    _keyboardFocus.dispose();
    super.dispose();
  }

  Future<void> _loadMetaLinks() async {
    try {
      final api = GroupsApi(widget.appState);
      final children = await api.getMetaLinks(widget.group.id);
      if (!mounted) return;
      setState(() {
        _selectedChildGroupIds = children.map((g) => g.id).toSet();
        _metaLoaded = true;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _metaLoaded = true);
    }
  }

  Future<void> _save() async {
    setState(() => _saving = true);

    try {
      final api = GroupsApi(widget.appState);

      if (_isMeta) {
        await api.updateMetaLinks(widget.group.id, _selectedChildGroupIds.toList());
        await widget.appState.loadGroups();
        if (!mounted) return;
        Navigator.pop(context);
        return;
      }

      final updated = await api.updateMembers(
        widget.group.id,
        _selectedMemberIds.toList(),
      );

      widget.appState.upsertGroup(updated);

      if (!mounted) return;
      Navigator.pop(context);
    } catch (e) {
      if (!mounted) return;
      setState(() => _saving = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("Save failed: $e")),
      );
    }
  }

  void _toggleSingleContact(Contact c) {
    setState(() {
      if (_selectedMemberIds.contains(c.id)) {
        _selectedMemberIds.remove(c.id);
      } else {
        _selectedMemberIds.add(c.id);
      }
    });
  }

  void _toggleRangeContacts(List<Contact> contacts, int a, int b, bool select) {
    final start = a < b ? a : b;
    final end = a < b ? b : a;

    setState(() {
      for (int i = start; i <= end; i++) {
        final id = contacts[i].id;
        if (select) {
          _selectedMemberIds.add(id);
        } else {
          _selectedMemberIds.remove(id);
        }
      }
    });
  }

  void _toggleChildGroup(String groupId) {
    setState(() {
      if (_selectedChildGroupIds.contains(groupId)) {
        _selectedChildGroupIds.remove(groupId);
      } else {
        _selectedChildGroupIds.add(groupId);
      }
    });
  }

  void _showMembersModalForGroup(Group g) {
    final members = g.members;
    final tooLarge = members.length > 20;
    final shown = members.take(20).toList();

    showDialog(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(g.name),
        content: SizedBox(
          width: 360,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (tooLarge)
                const Padding(
                  padding: EdgeInsets.only(bottom: 10),
                  child: Text(
                    "Large group — check Manage Groups for full member list.",
                    style: TextStyle(fontSize: 12),
                  ),
                ),
              ...shown.map((c) => Padding(
                    padding: const EdgeInsets.symmetric(vertical: 3),
                    child: Text(
                      c.name,
                      style: const TextStyle(fontWeight: FontWeight.w600),
                    ),
                  )),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text("Close"),
          ),
        ],
      ),
    );
  }

  void _showContactModal(Contact c) {
    showDialog(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(c.name),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if ((c.organization ?? "").trim().isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text("Org: ${c.organization}"),
              ),
            if ((c.phone ?? "").trim().isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Text("SMS: ${c.phone}"),
              ),
            if ((c.email ?? "").trim().isNotEmpty) Text("Email: ${c.email}"),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text("Close"),
          ),
        ],
      ),
    );
  }

  int _indexFromLocalDy(double dy) {
    final absolute = dy + _scrollOffset;
    final i = (absolute / _rowHeight).floor();
    return i < 0 ? 0 : i;
  }

  @override
  Widget build(BuildContext context) {
    final header = AppBar(
      title: Text(widget.group.name),
      backgroundColor: SFColors.primaryBlue,
      foregroundColor: Colors.white,
      actions: [
        IconButton(
          tooltip: "Save",
          onPressed: _saving ? null : _save,
          icon: _saving
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                )
              : const Icon(Icons.save),
        ),
      ],
    );

    if (_isMeta) {
      final allGroups = widget.appState.groups.where((g) => g.id != widget.group.id).toList();

      return Scaffold(
        appBar: header,
        body: !_metaLoaded
            ? const Center(child: CircularProgressIndicator())
            : SafeArea(
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    children: [
                      Row(
                        children: [
                          GestureDetector(
                            onTap: () => _showMembersModalForGroup(widget.group),
                            child: (widget.group.avatarKey != null && widget.group.avatarKey!.isNotEmpty)
                                ? GroupAvatarAtlas(avatarKey: widget.group.avatarKey!, size: 48)
                                : Container(
                                    width: 48,
                                    height: 48,
                                    decoration: BoxDecoration(
                                      color: Colors.black.withOpacity(0.06),
                                      borderRadius: BorderRadius.circular(14),
                                    ),
                                    child: const Icon(Icons.group_outlined),
                                  ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  widget.group.name,
                                  style: const TextStyle(fontWeight: FontWeight.w900, fontSize: 16),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  "${widget.group.memberCount} members",
                                  style: TextStyle(
                                    fontSize: 12,
                                    color: Colors.black.withOpacity(0.6),
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: Text(
                          "Linked Groups",
                          style: TextStyle(
                            fontWeight: FontWeight.w800,
                            color: SFColors.textPrimary.withOpacity(0.85),
                          ),
                        ),
                      ),
                      const SizedBox(height: 8),
                      Expanded(
                        child: ListView.builder(
                          itemCount: allGroups.length,
                          itemBuilder: (context, i) {
                            final g = allGroups[i];
                            final checked = _selectedChildGroupIds.contains(g.id);

                            return InkWell(
                              onTap: () => _toggleChildGroup(g.id),
                              child: Container(
                                height: 56,
                                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                                child: Row(
                                  children: [
                                    GestureDetector(
                                      onTap: () => _showMembersModalForGroup(g),
                                      child: (g.avatarKey != null && g.avatarKey!.isNotEmpty)
                                          ? GroupAvatarAtlas(avatarKey: g.avatarKey!, size: 40)
                                          : Container(
                                              width: 40,
                                              height: 40,
                                              decoration: BoxDecoration(
                                                color: Colors.black.withOpacity(0.06),
                                                borderRadius: BorderRadius.circular(12),
                                              ),
                                              child: const Icon(Icons.groups),
                                            ),
                                    ),
                                    const SizedBox(width: 10),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        mainAxisAlignment: MainAxisAlignment.center,
                                        children: [
                                          Text(
                                            g.name,
                                            style: const TextStyle(fontWeight: FontWeight.w800),
                                            overflow: TextOverflow.ellipsis,
                                          ),
                                          Text(
                                            "${g.memberCount} members",
                                            style: TextStyle(
                                              fontSize: 12,
                                              color: Colors.black.withOpacity(0.55),
                                              fontWeight: FontWeight.w600,
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                    Checkbox(
                                      value: checked,
                                      onChanged: (_) => _toggleChildGroup(g.id),
                                      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                      visualDensity: const VisualDensity(horizontal: -3, vertical: -3),
                                    ),
                                  ],
                                ),
                              ),
                            );
                          },
                        ),
                      ),
                    ],
                  ),
                ),
              ),
      );
    }

    final allContacts = widget.appState.contacts;
    final query = _search.text.toLowerCase();

    final contacts = allContacts
        .where((c) =>
            c.name.toLowerCase().contains(query) ||
            (c.organization ?? '').toLowerCase().contains(query))
        .toList()
      ..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));

    return Scaffold(
      appBar: header,
      body: RawKeyboardListener(
        focusNode: _keyboardFocus,
        autofocus: true,
        onKey: (evt) {
          final isShift = evt.logicalKey == LogicalKeyboardKey.shiftLeft ||
              evt.logicalKey == LogicalKeyboardKey.shiftRight;
          if (isShift) {
            setState(() {
              _shiftDown = evt is RawKeyDownEvent;
            });
          }
        },
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 12, 12, 8),
              child: TextField(
                controller: _search,
                decoration: InputDecoration(
                  hintText: "Search name or organization",
                  isDense: true,
                  filled: true,
                  fillColor: Colors.white,
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                ),
                onChanged: (_) => setState(() {}),
              ),
            ),
            if (_mobileDragMode)
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
                child: Row(
                  children: [
                    const Icon(Icons.swipe, size: 18),
                    const SizedBox(width: 8),
                    const Expanded(
                      child: Text(
                        "Range select: hold + slide. Release to finish.",
                        style: TextStyle(fontSize: 12),
                      ),
                    ),
                    TextButton(
                      onPressed: () => setState(() {
                        _mobileDragMode = false;
                        _mobileDragAnchorIndex = null;
                        _mobileDragLastIndex = null;
                      }),
                      child: const Text("Cancel"),
                    ),
                  ],
                ),
              ),
            Expanded(
              child: NotificationListener<ScrollNotification>(
                onNotification: (n) {
                  if (n.metrics.axis == Axis.vertical) {
                    _scrollOffset = n.metrics.pixels;
                  }
                  return false;
                },
                child: GestureDetector(
                  onLongPressStart: (d) {
                    if (kIsWeb) return;
                    setState(() {
                      _mobileDragMode = true;
                      _mobileDragAnchorIndex = _indexFromLocalDy(d.localPosition.dy);
                      _mobileDragLastIndex = _mobileDragAnchorIndex;
                    });
                  },
                  onLongPressMoveUpdate: (d) {
                    if (!_mobileDragMode) return;
                    final idx = _indexFromLocalDy(d.localPosition.dy);
                    if (idx == _mobileDragLastIndex) return;

                    final anchor = _mobileDragAnchorIndex ?? idx;
                    final boundedIdx = idx.clamp(0, contacts.length - 1);
                    final boundedAnchor = anchor.clamp(0, contacts.length - 1);

                    _toggleRangeContacts(contacts, boundedAnchor, boundedIdx, true);

                    setState(() {
                      _mobileDragLastIndex = boundedIdx;
                    });
                  },
                  onLongPressEnd: (_) {
                    if (!_mobileDragMode) return;
                    setState(() {
                      _mobileDragMode = false;
                      _mobileDragAnchorIndex = null;
                      _mobileDragLastIndex = null;
                    });
                  },
                  child: ListView.builder(
                    itemExtent: _rowHeight,
                    itemCount: contacts.length,
                    itemBuilder: (context, i) {
                      final c = contacts[i];
                      final selected = _selectedMemberIds.contains(c.id);

                      return CompactContactTile(
                        contact: c,
                        selected: selected,
                        onAvatarTap: () => _showContactModal(c),
                        onToggle: () {
                          final canShiftRange =
                              (kIsWeb ||
                                  defaultTargetPlatform == TargetPlatform.windows ||
                                  defaultTargetPlatform == TargetPlatform.macOS ||
                                  defaultTargetPlatform == TargetPlatform.linux) &&
                              _shiftDown;

                          if (canShiftRange && _lastTappedIndex != null) {
                            final select = !selected;
                            _toggleRangeContacts(contacts, _lastTappedIndex!, i, select);
                          } else {
                            _toggleSingleContact(c);
                          }

                          _lastTappedIndex = i;
                        },
                        onLongPressRow: () {
                          if (kIsWeb) return;
                          setState(() {
                            _mobileDragMode = true;
                            _mobileDragAnchorIndex = i;
                            _mobileDragLastIndex = i;
                          });
                        },
                      );
                    },
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}