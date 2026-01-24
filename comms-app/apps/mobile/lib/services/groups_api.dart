import '../core/app_state.dart';
import '../models/group.dart';

class GroupsApi {
  final AppState appState;
  GroupsApi(this.appState);

  Future<List<Group>> list() async => appState.groups;

  Future<void> updateMembers(String groupId, List<String> memberIds) async {
    final g = appState.groups.firstWhere((g) => g.id == groupId);

    g.members
      ..clear()
      ..addAll(
        appState.contacts.where((c) => memberIds.contains(c.id)),
      );

    
  }
}
