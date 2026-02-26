import '../core/app_state.dart';
import '../models/contact.dart';
import '../models/group.dart';
import 'api_client.dart';

class GroupsApi {
  final AppState appState;
  GroupsApi(this.appState);

  ApiClient _client() => ApiClient(baseUrl: appState.baseUrl);

  // -------------------------------
  // LIST
  // -------------------------------
  Future<List<Group>> list() async {
    final res = await _client().getJson('/v1/groups');
    final items = (res['groups'] as List? ?? []);

    return items.map((g) {
      final membersJson = (g['members'] as List? ?? []);
      final members = membersJson.map((c) {
        return Contact(
          id: c['id'] ?? '',
          name: c['name'] ?? 'Unknown',
          phone: c['phone'],
          email: c['email'],
          organization: c['organization'],
        );
      }).toList();

      final mc = g['memberCount'];
      final memberCount =
          mc is num ? mc.toInt() : members.length;

      return Group(
        id: g['id'] ?? '',
        name: g['name'] ?? '',
        type: (g['type'] ?? 'snapshot').toString(),
        memberCount: memberCount,
        avatarKey: g['avatarKey'],
        members: members,
      );
    }).toList();
  }

  // -------------------------------
  // CREATE
  // -------------------------------
Future<Group> create({
  required String name,
  String type = "snapshot",
  String? avatarKey,
}) async {
  final res = await _client().postJson('/v1/groups', {
    'name': name,
    'type': type,
    'avatarKey': avatarKey,
  });

    final g = res['group'] as Map<String, dynamic>;
    final membersJson = (g['members'] as List? ?? []);

    final members = membersJson.map((c) {
      return Contact(
        id: c['id'] ?? '',
        name: c['name'] ?? 'Unknown',
        phone: c['phone'],
        email: c['email'],
        organization: c['organization'],
      );
    }).toList();

    final mc = g['memberCount'];
    final memberCount =
        mc is num ? mc.toInt() : members.length;

    return Group(
      id: g['id'] ?? '',
      name: g['name'] ?? '',
      type: (g['type'] ?? 'snapshot').toString(),
      avatarKey: g['avatarKey'],
      memberCount: memberCount,
      
            members: members,
    );
  }

  // -------------------------------
  // UPDATE MEMBERS (PUT)
  // -------------------------------
  Future<Group> updateMembers(
      String groupId, List<String> memberIds) async {
    final res =
        await _client().putJson('/v1/groups/$groupId/members', {
      'memberIds': memberIds,
    });

    final g = res['group'] as Map<String, dynamic>;
    final membersJson = (g['members'] as List? ?? []);

    final members = membersJson.map((c) {
      return Contact(
        id: c['id'] ?? '',
        name: c['name'] ?? 'Unknown',
        phone: c['phone'],
        email: c['email'],
        organization: c['organization'],
      );
    }).toList();

    final mc = g['memberCount'];
    final memberCount =
        mc is num ? mc.toInt() : members.length;

    return Group(
      id: g['id'] ?? '',
      name: g['name'] ?? '',
      type: (g['type'] ?? 'snapshot').toString(),
      avatarKey: g['avatarKey'],
      memberCount: memberCount,
      members: members,
    );
  }

  // -------------------------------
  // UPDATE META LINKS (PUT)
  // -------------------------------
  Future<void> updateMetaLinks(
      String groupId, List<String> childGroupIds) async {
    await _client().putJson('/v1/groups/$groupId/meta-links', {
      'childGroupIds': childGroupIds,
    });
  }

  // -------------------------------
  // GET META LINKS
  // -------------------------------
  Future<List<Group>> getMetaLinks(String groupId) async {
    final res =
        await _client().getJson('/v1/groups/$groupId/meta-links');
    final items = (res['children'] as List? ?? []);

    return items.map((g) {
      return Group(
        id: g['id'] ?? '',
        name: g['name'] ?? '',
        type: (g['type'] ?? 'snapshot').toString(),
        avatarKey: g['avatarKey'],
        memberCount: 0,
        members: const [],
      );
    }).toList();
  }
}