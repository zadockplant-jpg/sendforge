import 'package:flutter/material.dart';

class GroupAvatarAtlas extends StatelessWidget {
  final String avatarKey;
  final double size;

  const GroupAvatarAtlas({
    super.key,
    required this.avatarKey,
    this.size = 44,
  });

  static const int columns = 6;

  int _indexFromKey(String key) {
    final n = int.tryParse(key.replaceAll("av_", ""));
    return n ?? 0;
  }

  @override
  Widget build(BuildContext context) {
    final index = _indexFromKey(avatarKey);
    final row = index ~/ columns;
    final col = index % columns;

    return ClipRRect(
      borderRadius: BorderRadius.circular(12),
      child: SizedBox(
        width: size,
        height: size,
        child: FittedBox(
          fit: BoxFit.cover,
          child: SizedBox(
            width: 600,
            height: 600,
            child: Transform.translate(
              offset: Offset(-col * 100, -row * 100),
              child: Image.asset(
                "assets/avatars/group_avatars.png",
                fit: BoxFit.cover,
              ),
            ),
          ),
        ),
      ),
    );
  }
}