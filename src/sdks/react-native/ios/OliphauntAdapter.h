#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@class OliphauntAdapterDatabase;

typedef void (^OliphauntOpenCompletion)(OliphauntAdapterDatabase *_Nullable database, NSError *_Nullable error);
typedef void (^OliphauntDataCompletion)(NSData *_Nullable value, NSError *_Nullable error);
typedef NSError *_Nullable (^OliphauntStreamChunk)(NSData *value);
typedef void (^OliphauntVoidCompletion)(NSError *_Nullable error);

@interface OliphauntAdapterDatabase : NSObject

+ (void)openWithConfig:(NSDictionary *)config completion:(OliphauntOpenCompletion)completion;
+ (void)restoreWithStorageKind:(NSString *)storageKind
                    storagePath:(nullable NSString *)storagePath
                    storageName:(nullable NSString *)storageName
                     backupData:(NSData *)backupData
                     completion:(OliphauntVoidCompletion)completion;

- (void)execProtocolData:(NSData *)request completion:(OliphauntDataCompletion)completion;
- (void)execProtocolStreamData:(NSData *)request
                       onChunk:(OliphauntStreamChunk)onChunk
                    completion:(OliphauntVoidCompletion)completion;
- (void)backupDataWithCompletion:(OliphauntDataCompletion)completion;
- (void)cancelWithCompletion:(OliphauntVoidCompletion)completion;
- (void)closeWithCompletion:(OliphauntVoidCompletion)completion;

@end

NS_ASSUME_NONNULL_END
