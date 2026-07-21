#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@class OliphauntAdapterDatabase;

typedef void (^OliphauntOpenCompletion)(OliphauntAdapterDatabase *_Nullable database, NSError *_Nullable error);
typedef void (^OliphauntStringCompletion)(NSString *_Nullable value, NSError *_Nullable error);
typedef void (^OliphauntDataCompletion)(NSData *_Nullable value, NSError *_Nullable error);
typedef void (^OliphauntDictionaryCompletion)(NSDictionary *_Nullable value, NSError *_Nullable error);
typedef void (^OliphauntArrayCompletion)(NSArray *_Nullable value, NSError *_Nullable error);
typedef void (^OliphauntStreamChunk)(NSData *value);
typedef void (^OliphauntVoidCompletion)(NSError *_Nullable error);

@interface OliphauntAdapterDatabase : NSObject

+ (void)openWithConfig:(NSDictionary *)config completion:(OliphauntOpenCompletion)completion;
+ (void)supportedModesWithCompletion:(OliphauntArrayCompletion)completion;
+ (void)packageSizeReportWithConfig:(NSDictionary *)config completion:(OliphauntDictionaryCompletion)completion;
+ (void)processMemoryWithCompletion:(OliphauntDictionaryCompletion)completion;
+ (void)restoreWithRoot:(NSString *)root
                 format:(NSString *)format
            artifactData:(NSData *)artifactData
        replaceExisting:(BOOL)replaceExisting
            libraryPath:(NSString *_Nullable)libraryPath
             completion:(OliphauntStringCompletion)completion;

- (void)execProtocolData:(NSData *)request completion:(OliphauntDataCompletion)completion;
- (void)execProtocolStreamData:(NSData *)request
                       onChunk:(OliphauntStreamChunk)onChunk
                    completion:(OliphauntVoidCompletion)completion;
- (void)backupDataWithFormat:(NSString *)format completion:(OliphauntDataCompletion)completion;
- (void)cancelWithCompletion:(OliphauntVoidCompletion)completion;
- (void)closeWithCompletion:(OliphauntVoidCompletion)completion;
- (void)capabilitiesWithCompletion:(OliphauntDictionaryCompletion)completion;

@end

NS_ASSUME_NONNULL_END
