import 'package:flutter/foundation.dart';

import '../models/group.dart';
import '../models/contact.dart';
import '../models/message.dart';
import '../models/blast.dart';
import '../services/api_client.dart';
import 'package:shared_preferences/shared_preferences.dart';

class AppState extends ChangeNotifier {
  // Auth / config
  String? token;
  String baseUrl = 'https://comms-app-1wo0.onrender.com';

  // Identity / billing (UI only for now)
  String userId = 'local-user';
  String planTier = 'free';

  // Core data
  final List<Group> groups = [];
  final List<Contact> contacts = [];

  final List<Message> threads = [];
  final Map<String, List<Message>> messagesByThread = {};

  BlastDraft? activeBlast;

  // ------------------------

  void setBaseUrl(String v) {
    baseUrl = v;
    notifyListeners();
  }

  Future<void> setToken(String? t) async {
  token = t;

  final prefs = await SharedPreferences.getInstance();

  if (t == null) {
    await prefs.remove('token');
  } else {
    await prefs.setString('token', t);
  }

  notifyListeners();
}

  void setPlanTier(String tier) {
    planTier = tier;
    notifyListeners();
  }

  /// 🔹 Load contacts from backend
  Future<void> loadContacts() async {
    final api = ApiClient(baseUrl: baseUrl);

    final response = await api.getJson('/v1/contacts');

    if (response['contacts'] is List) {
      contacts.clear();

      for (final item in response['contacts']) {
        contacts.add(
          Contact(
            id: item['id'] ?? '',
            name: item['name'] ?? 'Unknown',
            phone: item['phone'],
            email: item['email'],
          ),
        );
      }

      notifyListeners();
    }
  }

  /// Utility used by Create Blast
  List<Contact> resolveRecipientsForGroups(List<String> groupIds) {
    final memberIds = groups
        .where((g) => groupIds.contains(g.id))
        .expand((g) => g.members.map((m) => m.id))
        .toSet();

    return contacts.where((c) => memberIds.contains(c.id)).toList();
  }

  /// Adds mock thread when blast queued
  void addQueuedBlastAsThread({
    required String blastId,
    required String body,
  }) {
    final now = DateTime.now();

    final root = Message(
      id: blastId,
      sender: 'You',
      body: body,
      incoming: false,
      timestamp: now,
    );

    threads.insert(0, root);

    messagesByThread.putIfAbsent(blastId, () => []);
    messagesByThread[blastId]!.insert(
      0,
      Message(
        id: '${blastId}_m1',
        sender: 'You',
        body: body,
        incoming: false,
        timestamp: now,
      ),
    );

    notifyListeners();
  }
}
