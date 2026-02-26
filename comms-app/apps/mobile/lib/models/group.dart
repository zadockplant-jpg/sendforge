// comms-app/apps/mobile/lib/models/group.dart
import 'contact.dart';

class Group {
  final String id;
  final String name;
  final String? avatarKey;
  /// "snapshot" | "meta"
  final String type;

  /// For UI speed, backend returns this directly.
  final int memberCount;

  /// Backend returns members currently; keep for existing UI.
  final List<Contact> members;

  Group({
    required this.id,
    required this.name,
    required this.type,
    required this.memberCount,
    required this.avatarKey,
    required this.members,
  });

  int get smsCapableCount => members.where((m) => m.hasSms).length;
  int get emailCapableCount => members.where((m) => m.hasEmail).length;

  Group copyWith({
    String? id,
    String? name,
    String? type,
    int? memberCount,
    String? avatarKey,
    List<Contact>? members,
  }) {
    return Group(
      id: id ?? this.id,
      name: name ?? this.name,
      type: type ?? this.type,
      memberCount: memberCount ?? this.memberCount,
      avatarKey: avatarKey ?? this.avatarKey,
      members: members ?? this.members,
    );
  }
}