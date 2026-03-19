// apps/mobile/lib/ui/groups/group_avatar_atlas.dart
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
  static const int rows = 8;

  static const double atlasWidth = 1024;
  static const double atlasHeight = 1536;

  static const double tileWidth = atlasWidth / columns; // 170.666...
  static const double tileHeight = atlasHeight / rows;  // 192

  int _indexFromKey(String key) {
    final n = int.tryParse(key.replaceAll("av_", ""));
    return n ?? 0;
  }

  @override
  Widget build(BuildContext context) {
    final index = _indexFromKey(avatarKey).clamp(0, (columns * rows) - 1);
    final row = index ~/ columns;
    final col = index % columns;

    return ClipRRect(
      borderRadius: BorderRadius.circular(12),
      child: SizedBox(
        width: size,
        height: size,
        child: FittedBox(
          fit: BoxFit.cover,
          alignment: Alignment.topLeft,
          child: SizedBox(
            width: tileWidth,
            height: tileHeight,
            child: Stack(
              children: [
                Transform.translate(
                  offset: Offset(-col * tileWidth, -row * tileHeight),
                  child: Image.asset(
                    "assets/avatars/group_avatars.png",
                    width: atlasWidth,
                    height: atlasHeight,
                    fit: BoxFit.fill,
                    alignment: Alignment.topLeft,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}