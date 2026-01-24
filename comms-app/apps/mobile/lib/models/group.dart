import 'contact.dart';

class Group {
  final String id;
  final String name;
  final List<Contact> members;

  Group({
    required this.id,
    required this.name,
    required this.members,
  });

  int get memberCount => members.length;

  int get smsCapableCount => members.where((m) => m.hasSms).length;
  int get emailCapableCount => members.where((m) => m.hasEmail).length;
}
