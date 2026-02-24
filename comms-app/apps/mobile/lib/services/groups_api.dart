// comms-app/apps/mobile/lib/services/groups_api.dart
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
          id: c['id'] ?? '',
          name: c['name'] ?? 'Unknown',
          phone: c['phone'],
          email: c['email'],
          organization: c['organization'],
        );
      }).toList();

      return Group(
        id: g['id'] ?? '',
        name: g['name'] ?? '',
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

    return Group(
      id: g['id'] ?? '',
      name: g['name'] ?? '',
      type: (g['type'] ?? 'snapshot').toString(),
      memberCount: (g['memberCount'] ?? members.length) as int,
      members: members,
    );
  }

  Future<Group> updateMembers(String groupId, List<String> memberIds) async {
    final res = await _client().postJson('/v1/groups/$groupId/members', {
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

    return Group(
      id: g['id'] ?? '',
      name: g['name'] ?? '',
      type: (g['type'] ?? 'snapshot').toString(),
      memberCount: (g['memberCount'] ?? members.length) as int,
      members: members,
    );
  }

  Future<void> updateMetaLinks(String groupId, List<String> childGroupIds) async {
    await _client().postJson('/v1/groups/$groupId/meta-links', {
      'childGroupIds': childGroupIds,
    });
  }

  Future<List<Group>> getMetaLinks(String groupId) async {
    final res = await _client().getJson('/v1/groups/$groupId/meta-links');
    final items = (res['children'] as List? ?? []);
    return items.map((g) {
      return Group(
        id: g['id'] ?? '',
        name: g['name'] ?? '',
        type: (g['type'] ?? 'snapshot').toString(),
        memberCount: 0,
        members: const [],
      );
    }).toList();
  }
}