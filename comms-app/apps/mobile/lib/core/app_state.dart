import 'package:flutter/foundation.dart';

import '../models/group.dart';
import '../models/contact.dart';
import '../models/message.dart';
import '../models/blast.dart';

class AppState extends ChangeNotifier {
  // Auth / config
  String? token;
  String baseUrl = 'https://comms-app-1wo0.onrender.com';

  // Identity / billing (UI only for now)
  String userId = 'local-user';
  String planTier = 'free'; // free | pro | business

  // Core data (local MVP state)
  final List<Group> groups = [];
  final List<Contact> contacts = [];

  final List<Message> threads = [];
  final Map<String, List<Message>> messagesByThread = {};

  // Drafts
  BlastDraft? activeBlast;

  // ------------------------

  void setBaseUrl(String v) {
    baseUrl = v;
    notifyListeners();
  }

  void setToken(String? t) {
    token = t;
    notifyListeners();
  }

  void setPlanTier(String tier) {
    planTier = tier;
    notifyListeners();
  }

  /// Utility used by Create Blast
  List<Contact> resolveRecipientsForGroups(List<String> groupIds) {
    final memberIds = groups
        .where((g) => groupIds.contains(g.id))
        .expand((g) => g.members.map((m) => m.id))
        .toSet();

    return contacts.where((c) => memberIds.contains(c.id)).toList();
  }
}
