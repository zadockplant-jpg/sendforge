import 'package:flutter/foundation.dart';
import '../models/contact.dart';
import '../models/group.dart';
import '../services/api_client.dart';

class AppState extends ChangeNotifier {
  final String baseUrl;

  AppState({required this.baseUrl});

  List<Contact> contacts = [];
  List<Group> groups = [];

  bool contactsLoaded = false;
  bool groupsLoaded = false;

  ApiClient get api => ApiClient(baseUrl: baseUrl);

  Future<bool> hasToken() async {
    final t = await api.getToken();
    return t != null && t.isNotEmpty;
  }

  Future<void> loadContacts() async {
    final res = await api.getJson('/v1/contacts');

    final items = (res['contacts'] as List? ?? []);
    contacts = items.map((c) {
      return Contact(
        id: (c['id'] ?? '').toString(),
        name: (c['name'] ?? '').toString(),
        phone: c['phone']?.toString(),
        email: c['email']?.toString(),
        organization: c['organization']?.toString(),
      );
    }).toList();

    contactsLoaded = true;
    notifyListeners();
  }

  Future<void> loadGroups() async {
    final res = await api.getJson('/v1/groups');

    final items = (res['groups'] as List? ?? []);
    groups = items.map((g) {
      final membersJson = (g['members'] as List? ?? []);
      final members = membersJson.map((c) {
        return Contact(
          id: (c['id'] ?? '').toString(),
          name: (c['name'] ?? 'Unknown').toString(),
          phone: c['phone']?.toString(),
          email: c['email']?.toString(),
          organization: c['organization']?.toString(),
        );
      }).toList();

      return Group(
        id: (g['id'] ?? '').toString(),
        name: (g['name'] ?? '').toString(),
        type: (g['type'] ?? 'snapshot').toString(),
        memberCount: (g['memberCount'] ?? members.length) as int,
        members: members,
      );
    }).toList();

    groupsLoaded = true;
    notifyListeners();
  }

  Group? getGroupById(String id) {
    try {
      return groups.firstWhere((g) => g.id == id);
    } catch (_) {
      return null;
    }
  }

  Contact? getContactById(String id) {
    try {
      return contacts.firstWhere((c) => c.id == id);
    } catch (_) {
      return null;
    }
  }
}