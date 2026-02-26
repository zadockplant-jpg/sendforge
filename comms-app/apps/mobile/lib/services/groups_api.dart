import '../core/app_state.dart';
import '../models/contact.dart';
import '../models/group.dart';
import 'api_client.dart';

class GroupsApi {
  final AppState appState;
  GroupsApi(this.appState);

  ApiClient _client() => ApiClient(baseUrl: appState.baseUrl);

  Future<List<Group>> list() async {
    final res = await _client().getJson('/v1/groups');
    final items = (res['groups'] as List? ?? []);

    return items.map((g) {
      final membersJson = (g['members'] as List? ?? []);
      final members = membersJson.map((c) {
        return Contact(
          id: c['id']?.toString() ?? '',
          name: c['name']?.toString() ?? 'Unknown',
          phone: c['phone']?.toString(),
          email: c['email']?.toString(),
          organization: c['organization']?.toString(),
        );
      }).toList();

      return Group(
        id: g['id']?.toString() ?? '',
        name: g['name']?.toString() ?? '',
        type: (g['type'] ?? 'snapshot').toString(),
        memberCount: (g['memberCount'] ?? members.length) as int,
        members: members,
      );
    }).toList();
  }

  Future<Group> create({required String name, String type = "snapshot"}) async {
    final res = await _client().postJson('/v1/groups', {
      'name': name,
      'type': type,
    });

    final g = (res['group'] as Map?)?.cast<String, dynamic>() ?? {};
    return Group(
      id: g['id']?.toString() ?? '',
      name: g['name']?.toString() ?? '',
      type: (g['type'] ?? 'snapshot').toString(),
      memberCount: (g['memberCount'] ?? 0) as int,
      members: const [],
    );
  }

  Future<Group> updateMembers(String groupId, List<String> memberIds) async {
    // Backend uses PUT /v1/groups/:id/members
    final res = await _client().putJson('/v1/groups/$groupId/members', {
      'memberIds': memberIds,
    });

    final g = (res['group'] as Map?)?.cast<String, dynamic>() ?? {};
    final membersJson = (g['members'] as List? ?? []);
    final members = membersJson.map((c) {
      final m = (c as Map).cast<String, dynamic>();
      return Contact(
        id: m['id']?.toString() ?? '',
        name: m['name']?.toString() ?? 'Unknown',
        phone: m['phone']?.toString(),
        email: m['email']?.toString(),
        organization: m['organization']?.toString(),
      );
    }).toList();

    return Group(
      id: g['id']?.toString() ?? groupId,
      name: g['name']?.toString() ?? '',
      type: (g['type'] ?? 'snapshot').toString(),
      memberCount: (g['memberCount'] ?? members.length) as int,
      members: members,
    );
  }

  Future<void> updateMetaLinks(String groupId, List<String> childGroupIds) async {
    await _client().putJson('/v1/groups/$groupId/meta-links', {
      'childGroupIds': childGroupIds,
    });
  }

  Future<List<Group>> getMetaLinks(String groupId) async {
    final res = await _client().getJson('/v1/groups/$groupId/meta-links');
    final items = (res['children'] as List? ?? []);
    return items.map((g) {
      final m = (g as Map).cast<String, dynamic>();
      return Group(
        id: m['id']?.toString() ?? '',
        name: m['name']?.toString() ?? '',
        type: (m['type'] ?? 'snapshot').toString(),
        memberCount: 0,
        members: const [],
      );
    }).toList();
  }
}